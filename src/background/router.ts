/**
 * The background message router, expressed as a dependency-injected factory so
 * it can be exercised in unit tests without a live extension host.
 *
 * Every handler returns a promise; the chrome listener wrapper in
 * `service_worker.ts` is responsible for keeping the message channel open.
 */
import {
  err,
  ok,
  type BackgroundRequest,
  type Result,
  type RuntimeState,
  type SessionListResponse,
} from '../messages';
import type { RecordedEvent, ReplayErrorEntry, SessionData, SessionSummary } from '../types';
import { validateSessionData, sanitizeSessionData } from '../validation';
import type { StateStore } from './state';

export interface TabInfo {
  id: number;
  url: string;
}

export interface TabAdapter {
  queryActive(): Promise<TabInfo | null>;
  /** Resolves with `{ delivered: false }` instead of throwing when no receiver exists. */
  sendMessage(tabId: number, message: unknown): Promise<{ delivered: boolean; response?: unknown; error?: string }>;
  navigate(tabId: number, url: string): Promise<void>;
  injectContentScript(tabId: number): Promise<boolean>;
}

export interface DbAdapter {
  saveSession(session: SessionData): Promise<void>;
  appendSessionEvents(sessionId: string, events: RecordedEvent[]): Promise<number>;
  updateSessionMetadata(sessionId: string, patch: Partial<SessionSummary>): Promise<void>;
  updateSessionReplayResults(sessionId: string, errors: ReplayErrorEntry[]): Promise<void>;
  getSession(id: string): Promise<SessionData | null>;
  getSessionSummaries(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
}

export interface RouterDeps {
  db: DbAdapter;
  tabs: TabAdapter;
  state: StateStore;
  now?: () => number;
  newId?: () => string;
  userAgent?: string;
}

export type RouteResult = Result<unknown> | RuntimeState | SessionListResponse | { session: SessionData | null };

const RECEIVER_MISSING = /Receiving end does not exist|Could not establish connection/i;

function defaultId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isReplayableUrl(url: string | undefined): url is string {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

export function createRouter(deps: RouterDeps) {
  const { db, tabs, state } = deps;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? defaultId;
  const userAgent = deps.userAgent ?? (globalThis as { navigator?: Navigator }).navigator?.userAgent ?? 'Unknown';

  /**
   * Sends to a tab, injecting the content script once if it is not there yet.
   * The old code string-matched the error only on the first attempt and then
   * re-sent without the resume index, silently restarting replay from zero.
   */
  async function sendToTab(tabId: number, payload: unknown): Promise<Result> {
    const first = await tabs.sendMessage(tabId, payload);
    if (first.delivered) return ok(first.response);
    if (!RECEIVER_MISSING.test(first.error ?? '')) return err(first.error ?? 'Tab did not respond');

    const injected = await tabs.injectContentScript(tabId);
    if (!injected) return err('Could not inject the ReplayX content script into this tab');

    const second = await tabs.sendMessage(tabId, payload);
    return second.delivered ? ok(second.response) : err(second.error ?? 'Tab did not respond after injection');
  }

  async function buildState(): Promise<RuntimeState> {
    const current = await state.get();
    const replaySession = current.replay ? await db.getSession(current.replay.sessionId) : null;
    return {
      isRecording: Boolean(current.recording),
      isPaused: current.recording?.isPaused ?? false,
      currentSessionId: current.recording?.sessionId ?? null,
      recordingStartTime: current.recording?.startTime ?? null,
      currentTabId: current.recording?.tabId ?? null,
      isReplaying: Boolean(current.replay),
      isReplayPaused: current.replay?.isPaused ?? false,
      activeReplaySession: replaySession,
      replaySpeed: current.replay?.speed ?? 1,
      replayProgressIndex: current.replay?.progressIndex ?? 0,
      replayTotalEvents: replaySession?.events.length ?? 0,
    };
  }

  async function startRecording(): Promise<Result<{ sessionId: string }>> {
    const current = await state.get();
    if (current.recording) {
      return err('A recording is already in progress. Stop it before starting another.');
    }

    const tab = await tabs.queryActive();
    if (!tab?.id) return err('No active tab found. Open a web page and try again.');
    if (!isReplayableUrl(tab.url)) {
      return err('Recording only works on http:// and https:// pages.');
    }

    const sessionId = newId();
    const startTime = now();

    // The session record is created up front so event flushes have somewhere
    // durable to land even if the service worker is suspended mid-recording.
    await db.saveSession({
      id: sessionId,
      url: tab.url,
      startTime,
      events: [],
      metadata: {
        userAgent,
        viewport: { width: 0, height: 0 },
        totalEvents: 0,
        duration: 0,
        pageUrls: [tab.url],
        replayIssues: 0,
      },
    });

    await state.patch({
      recording: { sessionId, tabId: tab.id, startTime, url: tab.url, isPaused: false },
    });

    const result = await sendToTab(tab.id, { action: 'START_RECORD', sessionId, sessionStartTime: startTime });
    if (!result.success) {
      // Roll back so a failed start cannot wedge the extension in "recording".
      await state.patch({ recording: null });
      await db.deleteSession(sessionId).catch(() => {});
      return err(`Failed to start recording: ${result.error}. Try refreshing the page.`);
    }

    return ok({ sessionId });
  }

  async function stopRecording(): Promise<Result<{ sessionId: string }>> {
    const current = await state.get();
    const recording = current.recording;
    if (!recording) return err('No recording is in progress.');

    // Clear state first: whatever the content script does, the extension must
    // not be left believing it is still recording.
    await state.patch({ recording: null });

    const result = await sendToTab(recording.tabId, { action: 'STOP_RECORD' });
    const payload = (result.success ? (result as { data?: unknown }).data : null) as
      | { events?: RecordedEvent[]; initialState?: SessionData['initialState']; viewport?: { width: number; height: number } }
      | null;

    if (payload?.events?.length) {
      await db.appendSessionEvents(recording.sessionId, payload.events);
    }

    const session = await db.getSession(recording.sessionId);
    if (!session) return err('Recorded session could not be found in storage.');

    const pageUrls = Array.from(
      new Set([
        recording.url,
        ...session.events
          .filter((event) => event.type === 'Navigation')
          .map((event) => String((event.payload as { url?: string }).url ?? '')),
      ]),
    ).filter(Boolean);

    await db.updateSessionMetadata(recording.sessionId, {
      endTime: now(),
      initialState: payload?.initialState ?? session.initialState,
      metadata: {
        ...session.metadata,
        userAgent,
        viewport: payload?.viewport ?? session.metadata.viewport,
        totalEvents: session.events.length,
        duration: durationOf(session.events),
        pageUrls,
      },
    } as Partial<SessionSummary>);

    return ok({ sessionId: recording.sessionId });
  }

  async function setRecordingPaused(isPaused: boolean): Promise<Result> {
    const current = await state.get();
    const recording = current.recording;
    // The old code used a non-null assertion here and threw a TypeError
    // whenever the worker had been recycled.
    if (!recording) return err('No recording is in progress.');
    if (recording.isPaused === isPaused) return ok();

    await state.patch({ recording: { ...recording, isPaused } });
    await sendToTab(recording.tabId, { action: isPaused ? 'PAUSE_RECORDING' : 'RESUME_RECORDING' });
    return ok();
  }

  async function replaySession(request: Extract<BackgroundRequest, { action: 'REPLAY_SESSION' }>): Promise<Result> {
    if (!request.sessionId) return err('Missing sessionId');

    const existing = await state.get();
    if (existing.replay) await stopReplay();

    const session = await db.getSession(request.sessionId);
    if (!session) return err('Session not found');

    const tab = await tabs.queryActive();
    if (!tab?.id) return err('No active tab found');
    if (!isReplayableUrl(tab.url)) return err('Cannot replay on this tab type (restricted URL)');

    const speed = clampSpeed(request.speed ?? 1);
    const startIndex = Math.max(0, request.startIndex ?? 0);

    await state.patch({
      replay: { sessionId: session.id, tabId: tab.id, speed, isPaused: false, progressIndex: startIndex },
    });

    if (normalize(tab.url) !== normalize(session.url)) {
      // The content script pulls state via GET_STATE once it loads on the new page.
      await tabs.navigate(tab.id, session.url);
      return ok();
    }

    const result = await sendToTab(tab.id, {
      action: 'START_REPLAY',
      session,
      speed,
      resumeIndex: startIndex,
    });
    if (!result.success) {
      await state.patch({ replay: null });
      return result;
    }

    if (request.step) await tabs.sendMessage(tab.id, { action: 'STEP_REPLAY' });
    return ok();
  }

  async function stopReplay(): Promise<Result> {
    const current = await state.get();
    const replay = current.replay;
    await state.patch({ replay: null });
    if (replay) await tabs.sendMessage(replay.tabId, { action: 'STOP_REPLAY' });
    return ok();
  }

  async function setReplayPaused(isPaused: boolean): Promise<Result> {
    const current = await state.get();
    if (!current.replay) return err('No replay is in progress.');
    await state.patch({ replay: { ...current.replay, isPaused } });
    await tabs.sendMessage(current.replay.tabId, { action: isPaused ? 'PAUSE_REPLAY' : 'RESUME_REPLAY' });
    return ok();
  }

  async function handle(request: BackgroundRequest, senderTabId?: number): Promise<RouteResult> {
    switch (request.action) {
      case 'GET_STATE':
        return buildState();

      case 'START_RECORDING':
        return startRecording();

      case 'STOP_RECORDING':
        return stopRecording();

      case 'PAUSE_RECORDING':
        return setRecordingPaused(true);

      case 'RESUME_RECORDING':
        return setRecordingPaused(false);

      case 'SAVE_RECORDING_EVENTS': {
        const current = await state.get();
        if (!request.sessionId) return err('Missing sessionId');
        // Accept flushes from the recording tab even if state was just cleared
        // by a stop that raced the final beforeunload flush.
        if (current.recording && current.recording.sessionId !== request.sessionId) {
          return err('Session is not the active recording');
        }
        const count = await db.appendSessionEvents(request.sessionId, request.events ?? []);
        return ok({ saved: count });
      }

      case 'GET_SESSIONS':
        return { sessions: await db.getSessionSummaries() };

      case 'GET_SESSION': {
        if (!request.sessionId) return err('Missing sessionId');
        return { session: await db.getSession(request.sessionId) };
      }

      case 'DELETE_SESSION': {
        if (!request.sessionId) return err('Missing sessionId');
        await db.deleteSession(request.sessionId);
        return ok();
      }

      case 'EXPORT_SESSION': {
        if (!request.sessionId) return err('Missing sessionId');
        const session = await db.getSession(request.sessionId);
        if (!session) return err('Session not found');
        // The download itself happens in the popup: MV3 service workers have no
        // URL.createObjectURL, so the previous implementation always threw here.
        return ok({ session });
      }

      case 'IMPORT_SESSION': {
        const validation = validateSessionData(request.sessionData);
        if (!validation.valid) return err(validation.errors.slice(0, 5).join('; '));
        const sanitized = sanitizeSessionData(request.sessionData as SessionData);
        await db.saveSession(sanitized);
        return ok({ sessionId: sanitized.id });
      }

      case 'REPLAY_SESSION':
        return replaySession(request);

      case 'STOP_REPLAY':
        return stopReplay();

      case 'PAUSE_REPLAY':
        return setReplayPaused(true);

      case 'RESUME_REPLAY':
        return setReplayPaused(false);

      case 'SET_REPLAY_SPEED': {
        const current = await state.get();
        const speed = clampSpeed(request.speed);
        if (current.replay) {
          await state.patch({ replay: { ...current.replay, speed } });
          await tabs.sendMessage(current.replay.tabId, { action: 'SET_REPLAY_SPEED', speed });
        }
        return ok({ speed });
      }

      case 'STEP_REPLAY': {
        const current = await state.get();
        if (!current.replay) return err('No replay is in progress.');
        const result = await tabs.sendMessage(current.replay.tabId, { action: 'STEP_REPLAY' });
        return result.delivered ? ok() : err(result.error ?? 'Replay tab did not respond');
      }

      case 'UPDATE_REPLAY_PROGRESS': {
        const current = await state.get();
        if (!current.replay || current.replay.sessionId !== request.sessionId) {
          return err('Replay state mismatch');
        }
        const progressIndex = Number(request.progressIndex);
        await state.patch({
          replay: { ...current.replay, progressIndex: Number.isFinite(progressIndex) ? progressIndex : 0 },
        });
        return ok();
      }

      case 'REPLAY_FINISHED': {
        const current = await state.get();
        const replay = current.replay;
        await state.patch({ replay: null });
        if (replay) {
          // Persist only the diagnostics; the old handler rewrote every event
          // of the session on every replay.
          await db.updateSessionReplayResults(replay.sessionId, normalizeErrors(request.errors));
        }
        return ok();
      }

      default: {
        const unknown = request as { action?: string };
        void senderTabId;
        return err(`Unknown action: ${String(unknown?.action)}`);
      }
    }
  }

  return { handle, buildState, stopReplay };
}

export type Router = ReturnType<typeof createRouter>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function clampSpeed(speed: unknown): number {
  const value = Number(speed);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.1, Math.min(10, value));
}

function normalize(url: string): string {
  return (url.split('#')[0] ?? url).replace(/\/+$/, '').toLowerCase();
}

function durationOf(events: readonly RecordedEvent[]): number {
  if (events.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const event of events) {
    if (!Number.isFinite(event.timestamp)) continue;
    if (event.timestamp < min) min = event.timestamp;
    if (event.timestamp > max) max = event.timestamp;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}

function normalizeErrors(errors: unknown): ReplayErrorEntry[] {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 500).map((raw) => {
    const entry = (raw ?? {}) as ReplayErrorEntry & { event?: { id?: string; type?: string } };
    return {
      eventId: entry.eventId ?? entry.event?.id,
      eventType: entry.eventType ?? (entry.event?.type as ReplayErrorEntry['eventType']),
      code: entry.code,
      message: entry.message,
      details: entry.details,
      stage: entry.stage,
      timestamp: entry.timestamp ?? Date.now(),
      selector: entry.selector,
      targetTag: entry.targetTag,
      retryable: entry.retryable,
      severity: entry.severity,
      expected: entry.expected,
      actual: entry.actual,
    };
  });
}
