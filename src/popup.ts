import './popup.css';
import { collapseTimeline, getEventDetailSummary, getReplayStatusBadge, summarizeEvent } from './debugger';
import type { RuntimeState } from './messages';
import type { ReplayErrorEntry, SessionData, SessionSummary } from './types';
import { sanitizeSessionData, validateSessionData } from './validation';

/**
 * Popup UI.
 *
 * Every value rendered here originates from a recorded web page or from an
 * imported file, so the entire view is built with `createElement` +
 * `textContent`. The previous implementation interpolated session URLs, DOM
 * text snippets and replay error strings into `innerHTML`, which let any
 * recorded page inject script into a privileged extension page.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
};

const startBtn = el<HTMLButtonElement>('start-btn');
const stopBtn = el<HTMLButtonElement>('stop-btn');
const pauseBtn = el<HTMLButtonElement>('pause-btn');
const resumeBtn = el<HTMLButtonElement>('resume-btn');
const stepBtn = el<HTMLButtonElement>('step-btn');
const stopReplayBtn = el<HTMLButtonElement>('stop-replay-btn');
const sessionsContainer = el<HTMLDivElement>('sessions');
const statusText = el<HTMLSpanElement>('status');
const replayControls = el<HTMLDivElement>('replay-controls');
const speedControl = el<HTMLInputElement>('speed-control');
const speedValue = el<HTMLSpanElement>('speed-value');
const progressBar = el<HTMLDivElement>('progress-bar');
const progressLabel = el<HTMLSpanElement>('progress-label');
const debuggerPanel = el<HTMLDivElement>('session-debugger');
const importBtn = el<HTMLButtonElement>('import-btn');
const importInput = el<HTMLInputElement>('import-input');
const errorBanner = el<HTMLDivElement>('error-banner');

interface UiState {
  isRecording: boolean;
  isPaused: boolean;
  isReplaying: boolean;
  isReplayPaused: boolean;
  replaySpeed: number;
  replayProgress: number;
  replayTotal: number;
  showDebugger: boolean;
  activeSessionId: string | null;
}

let ui: UiState = {
  isRecording: false,
  isPaused: false,
  isReplaying: false,
  isReplayPaused: false,
  replaySpeed: 1,
  replayProgress: 0,
  replayTotal: 0,
  showDebugger: false,
  activeSessionId: null,
};

let sessions: SessionSummary[] = [];
let speedIsBeingDragged = false;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send<T = unknown>(message: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[ReplayX Popup]', message.action, chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response as T);
      });
    } catch (error) {
      console.warn('[ReplayX Popup] send failed:', error);
      resolve(null);
    }
  });
}

function showError(text: string): void {
  errorBanner.textContent = text;
  errorBanner.style.display = 'block';
  window.setTimeout(() => {
    errorBanner.style.display = 'none';
  }, 6000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(updates: Partial<UiState> = {}): void {
  ui = { ...ui, ...updates };

  startBtn.disabled = ui.isRecording || ui.isReplaying;
  stopBtn.disabled = !ui.isRecording;

  const isActive = ui.isRecording || ui.isReplaying;
  const isPaused = ui.isPaused || ui.isReplayPaused;

  pauseBtn.style.display = isActive && !isPaused ? 'inline-block' : 'none';
  resumeBtn.style.display = isActive && isPaused ? 'inline-block' : 'none';
  pauseBtn.disabled = !isActive;
  resumeBtn.disabled = !isActive;
  resumeBtn.textContent = ui.isRecording ? 'Resume Recording' : 'Resume Replay';

  if (ui.isReplaying && ui.isReplayPaused) setStatus('Replay Paused', '#ecc94b');
  else if (ui.isReplaying) setStatus('Replaying…', '#38a169');
  else if (ui.isRecording && ui.isPaused) setStatus('Recording Paused', '#ecc94b');
  else if (ui.isRecording) setStatus('Recording…', '#e53e3e');
  else setStatus('Idle', '#718096');

  replayControls.style.display = ui.isReplaying ? 'block' : 'none';
  if (!speedIsBeingDragged) speedControl.value = String(ui.replaySpeed);
  speedValue.textContent = `${ui.replaySpeed}x`;

  const percent = ui.replayTotal > 0 ? Math.min(100, (ui.replayProgress / ui.replayTotal) * 100) : 0;
  progressBar.style.width = `${percent.toFixed(1)}%`;
  progressLabel.textContent = ui.replayTotal > 0 ? `${ui.replayProgress} / ${ui.replayTotal}` : '';

  debuggerPanel.style.display = ui.showDebugger ? 'block' : 'none';
}

function setStatus(text: string, color: string): void {
  statusText.textContent = text;
  statusText.style.color = color;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; title?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  return node;
}

function displayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.pathname === '/' ? url.hostname : `${url.hostname}${url.pathname}`;
  } catch {
    return rawUrl || 'unknown';
  }
}

function renderSessions(): void {
  sessionsContainer.replaceChildren();

  if (sessions.length === 0) {
    sessionsContainer.append(element('span', { className: 'empty', text: 'No sessions recorded yet.' }));
    return;
  }

  // A copy is sorted; sorting the shared array in place reordered state the
  // rest of the popup was still holding references into.
  const ordered = [...sessions].sort((a, b) => b.startTime - a.startTime);

  for (const session of ordered) {
    const item = element('div', { className: 'session-item' });

    const info = element('div', { className: 'session-info' });
    info.append(element('strong', { text: new Date(session.startTime).toLocaleString() }));
    info.append(document.createElement('br'));
    info.append(element('span', { text: displayUrl(session.url), title: session.url }));
    info.append(document.createElement('br'));

    const eventCount = session.metadata?.totalEvents ?? 0;
    const duration = session.metadata?.duration
      ? `${(session.metadata.duration / 1000).toFixed(1)}s`
      : 'unknown';
    const issues = session.replayErrors?.length ?? session.metadata?.replayIssues ?? 0;
    const pages = session.metadata?.pageUrls?.length ?? 0;

    const parts = [`Events: ${eventCount}`, `Duration: ${duration}`];
    if (pages > 1) parts.push(`Pages: ${pages}`);
    if (issues > 0) parts.push(`Issues: ${issues}`);
    info.append(element('span', { className: 'session-meta', text: parts.join(' | ') }));

    const actions = element('div', { className: 'session-actions' });
    actions.append(button('Replay', 'replay-btn', () => replaySession(session.id)));
    actions.append(button('View', 'view-btn', () => toggleDebugger(session.id)));
    actions.append(button('Export', 'export-btn', () => exportSession(session.id)));
    actions.append(button('Delete', 'delete-btn', () => deleteSession(session.id)));

    item.append(info, actions);
    sessionsContainer.append(item);
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', { className, text: label });
  node.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return node;
}

function section(title: string): { wrapper: HTMLDivElement; list: HTMLDivElement } {
  const wrapper = element('div', { className: 'debugger-section' });
  wrapper.append(element('div', { className: 'debugger-section-title', text: title }));
  const list = element('div', { className: 'debugger-list' });
  wrapper.append(list);
  return { wrapper, list };
}

function detailRow(title: string, meta: string, body: string): HTMLDivElement {
  const row = element('div', { className: 'debugger-item' });
  row.append(element('strong', { text: title }));
  row.append(element('div', { className: 'debugger-meta', text: meta }));
  if (body) row.append(element('div', { className: 'debugger-body', text: body }));
  return row;
}

function renderDebugger(session: SessionData): void {
  ui.showDebugger = true;
  ui.activeSessionId = session.id;
  debuggerPanel.replaceChildren();

  const events = session.events ?? [];
  const errors: ReplayErrorEntry[] = session.replayErrors ?? [];
  const networkEvents = events.filter((event) => event.type === 'Network');
  const badge = getReplayStatusBadge(session);

  const header = element('div', { className: 'debugger-header' });
  const heading = element('div');
  heading.append(element('div', { className: 'debugger-title', text: 'Replay debugger' }));
  heading.append(
    element('div', {
      className: 'debugger-subtitle',
      text: `Session ${session.id.slice(0, 8)} • ${events.length} events`,
    }),
  );
  const headerActions = element('div', { className: 'debugger-actions' });
  headerActions.append(button('Close', 'close-btn', closeDebugger));
  headerActions.append(button('Replay from start', 'restart-btn', () => replaySession(session.id)));
  header.append(heading, headerActions);

  const summary = element('div', { className: 'debugger-summary' });
  summary.append(chip('Events', String(events.length), ''));
  summary.append(
    chip(badge.label, String(badge.count), badge.variant === 'warning' ? 'debugger-chip-warning' : 'debugger-chip-success'),
  );
  summary.append(chip('Network', String(networkEvents.length), ''));

  const issues = section('Recent issues');
  if (errors.length === 0) {
    issues.list.append(element('div', { className: 'debugger-empty', text: 'No replay issues recorded.' }));
  } else {
    for (const error of errors.slice(0, 10)) {
      // The event type and time are what let a reader find the interaction in
      // the timeline; without them a finding is not actionable.
      const meta = [
        error.eventType ? `${error.eventType} event` : '',
        typeof error.timestamp === 'number' ? `${error.timestamp}ms` : '',
        error.severity ?? 'warning',
        error.stage ?? 'playback',
        error.code,
      ]
        .filter(Boolean)
        .join(' • ');
      const bodyLines = [
        error.details,
        error.selector ? `Selector: ${error.selector}` : '',
        error.expected ? `Expected: ${error.expected}` : '',
        error.actual ? `Actual: ${error.actual}` : '',
      ].filter(Boolean);
      issues.list.append(
        detailRow(error.message || error.code || 'Replay issue', meta, bodyLines.join('\n')),
      );
    }
  }

  const timeline = section('Event timeline');
  if (events.length === 0) {
    timeline.list.append(element('div', { className: 'debugger-empty', text: 'No events captured.' }));
  } else {
    // A page load can emit hundreds of DOM mutations in a burst. Rendering them
    // one per row pushed the interactions that actually matter off the visible
    // timeline, so consecutive runs are collapsed into a single entry.
    for (const entry of collapseTimeline(events, 25)) {
      if (entry.kind === 'run') {
        timeline.list.append(
          detailRow(
            `${entry.count} DOM mutations`,
            `${entry.from}ms – ${entry.to}ms`,
            'Collapsed: page-driven DOM churn between interactions.',
          ),
        );
      } else {
        timeline.list.append(
          detailRow(entry.event.type, `${entry.event.timestamp}ms`, summarizeEvent(entry.event)),
        );
      }
    }
  }

  const network = section('Network log');
  if (networkEvents.length === 0) {
    network.list.append(element('div', { className: 'debugger-empty', text: 'No network events captured.' }));
  } else {
    for (const event of networkEvents.slice(0, 25)) {
      const detail = getEventDetailSummary(event);
      network.list.append(detailRow(detail.title, detail.meta, detail.body));
    }
  }

  debuggerPanel.append(header, summary, issues.wrapper, timeline.wrapper, network.wrapper);
  render();
}

function chip(label: string, value: string, className: string): HTMLDivElement {
  const node = element('div', { className: `debugger-chip ${className}`.trim() });
  node.append(element('span', { text: label }));
  node.append(document.createElement('br'));
  node.append(element('strong', { text: value }));
  return node;
}

function closeDebugger(): void {
  ui.showDebugger = false;
  ui.activeSessionId = null;
  debuggerPanel.replaceChildren();
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function loadSessions(): Promise<void> {
  const response = await send<{ sessions?: SessionSummary[]; error?: string }>({ action: 'GET_SESSIONS' });
  // The old code read `response.error` without checking that `response` existed,
  // turning a dropped message into a TypeError.
  if (!response) {
    showError('Could not reach the ReplayX background worker.');
    return;
  }
  sessions = response.sessions ?? [];
  renderSessions();
}

async function loadState(): Promise<void> {
  const state = await send<RuntimeState>({ action: 'GET_STATE' });
  if (!state) return;
  render({
    isRecording: Boolean(state.isRecording),
    isPaused: Boolean(state.isPaused),
    isReplaying: Boolean(state.isReplaying),
    isReplayPaused: Boolean(state.isReplayPaused),
    replaySpeed: state.replaySpeed || 1,
    replayProgress: state.replayProgressIndex ?? 0,
    replayTotal: state.replayTotalEvents ?? 0,
  });
}

async function toggleDebugger(sessionId: string): Promise<void> {
  if (ui.activeSessionId === sessionId && ui.showDebugger) {
    closeDebugger();
    return;
  }
  const response = await send<{ session?: SessionData | null; error?: string }>({
    action: 'GET_SESSION',
    sessionId,
  });
  if (!response?.session) {
    showError('Could not load session details.');
    return;
  }
  renderDebugger(response.session);
}

async function replaySession(sessionId: string): Promise<void> {
  const response = await send<{ success?: boolean; error?: string }>({
    action: 'REPLAY_SESSION',
    sessionId,
    speed: Number.parseFloat(speedControl.value) || 1,
  });
  if (!response?.success) {
    showError(`Failed to start replay: ${response?.error ?? 'unknown error'}`);
    return;
  }
  render({ isReplaying: true });
  window.close();
}

/**
 * The export download happens here rather than in the background: MV3 service
 * workers have no `URL.createObjectURL`, so the previous background-side
 * implementation threw on every attempt.
 */
async function exportSession(sessionId: string): Promise<void> {
  const response = await send<{ success?: boolean; data?: { session: SessionData }; error?: string }>({
    action: 'EXPORT_SESSION',
    sessionId,
  });
  if (!response?.success || !response.data?.session) {
    showError(`Failed to export session: ${response?.error ?? 'unknown error'}`);
    return;
  }

  const blob = new Blob([JSON.stringify(response.data.session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `replayx-session-${sessionId}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download before it starts.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function deleteSession(sessionId: string): Promise<void> {
  if (!window.confirm('Delete this session? This cannot be undone.')) return;
  const response = await send<{ success?: boolean; error?: string }>({ action: 'DELETE_SESSION', sessionId });
  if (!response?.success) {
    showError(`Failed to delete session: ${response?.error ?? 'unknown error'}`);
    return;
  }
  if (ui.activeSessionId === sessionId) closeDebugger();
  await loadSessions();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

startBtn.addEventListener('click', async () => {
  render({ isRecording: true });
  const response = await send<{ success?: boolean; error?: string }>({ action: 'START_RECORDING' });
  if (!response?.success) {
    render({ isRecording: false });
    showError(response?.error ?? 'Failed to start recording.');
  }
});

stopBtn.addEventListener('click', async () => {
  render({ isRecording: false });
  const response = await send<{ success?: boolean; error?: string }>({ action: 'STOP_RECORDING' });
  if (!response?.success) showError(response?.error ?? 'Failed to stop recording.');
  await loadSessions();
  await loadState();
});

pauseBtn.addEventListener('click', async () => {
  await send({ action: ui.isReplaying ? 'PAUSE_REPLAY' : 'PAUSE_RECORDING' });
  await loadState();
});

resumeBtn.addEventListener('click', async () => {
  await send({ action: ui.isReplaying ? 'RESUME_REPLAY' : 'RESUME_RECORDING' });
  await loadState();
});

stepBtn.addEventListener('click', async () => {
  const response = await send<{ success?: boolean; error?: string }>({ action: 'STEP_REPLAY' });
  if (!response?.success) showError(response?.error ?? 'Failed to step replay.');
});

stopReplayBtn.addEventListener('click', async () => {
  await send({ action: 'STOP_REPLAY' });
  render({ isReplaying: false });
  await loadState();
});

speedControl.addEventListener('pointerdown', () => {
  speedIsBeingDragged = true;
});
speedControl.addEventListener('pointerup', () => {
  speedIsBeingDragged = false;
});
speedControl.addEventListener('input', () => {
  const speed = Number.parseFloat(speedControl.value) || 1;
  speedValue.textContent = `${speed}x`;
  void send({ action: 'SET_REPLAY_SPEED', speed });
});

importBtn.addEventListener('click', () => importInput.click());

importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;

  if (file.size > 50 * 1024 * 1024) {
    showError('File too large. The maximum session size is 50MB.');
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => showError('Could not read the selected file.');
  reader.onload = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (error) {
      showError(`Invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`);
      return;
    }

    const validation = validateSessionData(parsed);
    if (!validation.valid) {
      showError(`Invalid session: ${validation.errors.slice(0, 3).join('; ')}`);
      return;
    }

    const response = await send<{ success?: boolean; error?: string }>({
      action: 'IMPORT_SESSION',
      sessionData: sanitizeSessionData(parsed as SessionData),
    });
    if (!response?.success) {
      showError(`Failed to import: ${response?.error ?? 'unknown error'}`);
      return;
    }
    await loadSessions();
  };
  reader.readAsText(file);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void loadState();
void loadSessions();

// Poll only while something is actually in flight; the previous unconditional
// 1s timer woke the service worker forever, even on an idle popup.
let pollTimer: number | null = null;

function syncPolling(): void {
  const shouldPoll = ui.isRecording || ui.isReplaying;
  if (shouldPoll && pollTimer === null) {
    pollTimer = window.setInterval(() => void loadState(), 1000);
  } else if (!shouldPoll && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

window.setInterval(() => {
  syncPolling();
  if (!ui.isRecording && !ui.isReplaying) void loadState();
}, 2000);

window.addEventListener('unload', () => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
});
