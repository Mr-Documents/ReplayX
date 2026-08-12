import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clampSpeed, createRouter, type DbAdapter, type TabAdapter } from './router';
import { createMemoryStateStore, type StateStore } from './state';
import type { RuntimeState } from '../messages';
import type { RecordedEvent, SessionData, SessionSummary } from '../types';

function makeSession(id: string, overrides: Partial<SessionData> = {}): SessionData {
  return {
    id,
    url: 'https://example.com/app',
    startTime: 1_000,
    events: [],
    metadata: {
      userAgent: 'test',
      viewport: { width: 800, height: 600 },
      totalEvents: 0,
      duration: 0,
      pageUrls: ['https://example.com/app'],
    },
    ...overrides,
  };
}

function makeEvent(index: number, sessionId: string, type: RecordedEvent['type'] = 'Click'): RecordedEvent {
  return {
    id: `e-${index}`,
    sessionId,
    timestamp: index * 100,
    type,
    payload: { selector: '#x', x: 0, y: 0 },
  } as RecordedEvent;
}

interface Harness {
  router: ReturnType<typeof createRouter>;
  db: DbAdapter;
  tabs: TabAdapter;
  state: StateStore;
  sessions: Map<string, SessionData>;
}

function harness(options: { activeTab?: { id: number; url: string } | null; delivered?: boolean } = {}): Harness {
  const sessions = new Map<string, SessionData>();

  const db: DbAdapter = {
    saveSession: vi.fn(async (session) => {
      sessions.set(session.id, JSON.parse(JSON.stringify(session)));
    }),
    appendSessionEvents: vi.fn(async (id, events) => {
      const session = sessions.get(id);
      if (session) session.events.push(...events);
      return events.length;
    }),
    updateSessionMetadata: vi.fn(async (id, patch) => {
      const session = sessions.get(id);
      if (session) Object.assign(session, patch);
    }),
    updateSessionReplayResults: vi.fn(async (id, errors) => {
      const session = sessions.get(id);
      if (session) session.replayErrors = errors;
    }),
    getSession: vi.fn(async (id) => sessions.get(id) ?? null),
    getSessionSummaries: vi.fn(async () =>
      [...sessions.values()].map(({ events: _e, ...rest }) => rest as SessionSummary),
    ),
    deleteSession: vi.fn(async (id) => {
      sessions.delete(id);
    }),
  };

  const activeTab = options.activeTab === undefined ? { id: 7, url: 'https://example.com/app' } : options.activeTab;
  const delivered = options.delivered ?? true;

  const tabs: TabAdapter = {
    queryActive: vi.fn(async () => activeTab),
    sendMessage: vi.fn(async () =>
      delivered
        ? { delivered: true, response: { success: true } }
        : { delivered: false, error: 'Receiving end does not exist' },
    ),
    navigate: vi.fn(async () => {}),
    injectContentScript: vi.fn(async () => true),
  };

  const state = createMemoryStateStore();
  return { router: createRouter({ db, tabs, state, now: () => 5_000, newId: () => 'sid' }), db, tabs, state, sessions };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clampSpeed', () => {
  it('bounds the range and rejects non-numbers', () => {
    expect(clampSpeed(2)).toBe(2);
    expect(clampSpeed(0)).toBe(0.1);
    expect(clampSpeed(1000)).toBe(10);
    expect(clampSpeed('abc')).toBe(1);
    expect(clampSpeed(undefined)).toBe(1);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });
});

describe('unknown actions', () => {
  it('answers with an error rather than throwing', async () => {
    const { router } = harness();
    const result = await router.handle({ action: 'NOPE' } as never);
    expect(result).toEqual({ success: false, error: 'Unknown action: NOPE' });
  });
});

describe('recording', () => {
  it('creates the session record before the content script is told to start', async () => {
    const { router, db, sessions } = harness();
    const result = await router.handle({ action: 'START_RECORDING' });

    expect(result).toMatchObject({ success: true, data: { sessionId: 'sid' } });
    // Persisting up front is what lets event flushes survive a worker restart.
    expect(db.saveSession).toHaveBeenCalled();
    expect(sessions.has('sid')).toBe(true);
  });

  it('refuses a second concurrent recording', async () => {
    const { router } = harness();
    await router.handle({ action: 'START_RECORDING' });
    const result = await router.handle({ action: 'START_RECORDING' });
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/already in progress/i);
  });

  it('rejects restricted urls', async () => {
    const { router } = harness({ activeTab: { id: 1, url: 'chrome://extensions' } });
    const result = await router.handle({ action: 'START_RECORDING' });
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/http/i);
  });

  it('rejects when there is no active tab', async () => {
    const { router } = harness({ activeTab: null });
    expect(await router.handle({ action: 'START_RECORDING' })).toMatchObject({ success: false });
  });

  it('rolls back state when the content script cannot be reached', async () => {
    const { state } = harness({ delivered: false });
    const tabs = {
      queryActive: async () => ({ id: 7, url: 'https://example.com/app' }),
      sendMessage: async () => ({ delivered: false, error: 'Receiving end does not exist' }),
      navigate: async () => {},
      injectContentScript: async () => false,
    } satisfies TabAdapter;
    const rolled = createRouter({ db: harness().db, tabs, state, now: () => 1, newId: () => 'sid' });
    const result = await rolled.handle({ action: 'START_RECORDING' });
    expect(result).toMatchObject({ success: false });
    // A failed start must not leave the extension stuck in "recording".
    expect((await state.get()).recording).toBeNull();
  });

  it('injects the content script once and retries delivery', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ delivered: false, error: 'Receiving end does not exist' })
      .mockResolvedValueOnce({ delivered: true, response: { success: true } });
    const injectContentScript = vi.fn(async () => true);
    const base = harness();
    const router = createRouter({
      db: base.db,
      tabs: { queryActive: async () => ({ id: 7, url: 'https://example.com/app' }), sendMessage, navigate: async () => {}, injectContentScript },
      state: createMemoryStateStore(),
      newId: () => 'sid',
    });

    expect(await router.handle({ action: 'START_RECORDING' })).toMatchObject({ success: true });
    expect(injectContentScript).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports an error when stopping without a recording', async () => {
    const { router } = harness();
    expect(await router.handle({ action: 'STOP_RECORDING' })).toMatchObject({ success: false });
  });

  it('finalises metadata on stop', async () => {
    const { router, db, sessions } = harness();
    await router.handle({ action: 'START_RECORDING' });
    await router.handle({
      action: 'SAVE_RECORDING_EVENTS',
      sessionId: 'sid',
      events: [makeEvent(0, 'sid'), makeEvent(5, 'sid')],
    });

    const result = await router.handle({ action: 'STOP_RECORDING' });
    expect(result).toMatchObject({ success: true, data: { sessionId: 'sid' } });
    expect(db.updateSessionMetadata).toHaveBeenCalled();
    expect(sessions.get('sid')?.events).toHaveLength(2);
  });

  it('clears recording state even if the tab never answers STOP_RECORD', async () => {
    const { router, state } = harness({ delivered: false });
    await router.handle({ action: 'START_RECORDING' }).catch(() => {});
    await state.patch({
      recording: { sessionId: 'sid', tabId: 7, startTime: 1, url: 'https://example.com/app', isPaused: false },
    });
    await router.handle({ action: 'STOP_RECORDING' });
    expect((await state.get()).recording).toBeNull();
  });

  it('pauses and resumes without throwing when the worker was recycled', async () => {
    // The old handler used a non-null assertion on a Map that MV3 had wiped.
    const { router } = harness();
    expect(await router.handle({ action: 'PAUSE_RECORDING' })).toMatchObject({ success: false });

    await router.handle({ action: 'START_RECORDING' });
    expect(await router.handle({ action: 'PAUSE_RECORDING' })).toMatchObject({ success: true });
    const state = (await router.handle({ action: 'GET_STATE' })) as RuntimeState;
    expect(state.isPaused).toBe(true);

    expect(await router.handle({ action: 'RESUME_RECORDING' })).toMatchObject({ success: true });
  });

  it('rejects event flushes for a different session', async () => {
    const { router } = harness();
    await router.handle({ action: 'START_RECORDING' });
    const result = await router.handle({ action: 'SAVE_RECORDING_EVENTS', sessionId: 'other', events: [] });
    expect(result).toMatchObject({ success: false });
  });

  it('accepts a late flush that races the stop', async () => {
    const { router, db } = harness();
    await router.handle({ action: 'START_RECORDING' });
    await router.handle({ action: 'STOP_RECORDING' });
    const result = await router.handle({
      action: 'SAVE_RECORDING_EVENTS',
      sessionId: 'sid',
      events: [makeEvent(0, 'sid')],
    });
    expect(result).toMatchObject({ success: true });
    expect(db.appendSessionEvents).toHaveBeenCalled();
  });
});

describe('replay', () => {
  it('starts replay on a matching url', async () => {
    const { router, sessions, tabs } = harness();
    sessions.set('s1', makeSession('s1', { events: [makeEvent(0, 's1')] }));

    expect(await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1', speed: 2 })).toMatchObject({
      success: true,
    });
    expect(tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'START_REPLAY', speed: 2, resumeIndex: 0 }),
    );
  });

  it('navigates first when the tab is on a different url', async () => {
    const { router, sessions, tabs } = harness();
    sessions.set('s1', makeSession('s1', { url: 'https://other.test/page' }));

    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1' });
    expect(tabs.navigate).toHaveBeenCalledWith(7, 'https://other.test/page');
  });

  it('forwards an explicit start index', async () => {
    const { router, sessions, tabs } = harness();
    sessions.set('s1', makeSession('s1'));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1', startIndex: 12 });
    expect(tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ resumeIndex: 12 }));
  });

  it('reports a missing session', async () => {
    const { router } = harness();
    expect(await router.handle({ action: 'REPLAY_SESSION', sessionId: 'ghost' })).toMatchObject({
      success: false,
      error: 'Session not found',
    });
  });

  it('tracks progress and rejects mismatched sessions', async () => {
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1'));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1' });

    expect(
      await router.handle({ action: 'UPDATE_REPLAY_PROGRESS', sessionId: 's1', progressIndex: 4 }),
    ).toMatchObject({ success: true });
    expect(
      await router.handle({ action: 'UPDATE_REPLAY_PROGRESS', sessionId: 'other', progressIndex: 9 }),
    ).toMatchObject({ success: false });

    const state = (await router.handle({ action: 'GET_STATE' })) as RuntimeState;
    expect(state.replayProgressIndex).toBe(4);
  });

  it('persists only diagnostics when replay finishes', async () => {
    const { router, db, sessions } = harness();
    sessions.set('s1', makeSession('s1', { events: [makeEvent(0, 's1'), makeEvent(1, 's1')] }));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1' });

    await router.handle({
      action: 'REPLAY_FINISHED',
      errors: [{ code: 'dom_mismatch', message: 'no change' }],
    });

    // Rewriting the whole session (the old behaviour) re-serialised every event.
    expect(db.saveSession).not.toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    expect(db.updateSessionReplayResults).toHaveBeenCalledWith('s1', [
      expect.objectContaining({ code: 'dom_mismatch' }),
    ]);
    expect(sessions.get('s1')?.events).toHaveLength(2);
  });

  it('clears replay state when replay finishes', async () => {
    const { router, sessions, state } = harness();
    sessions.set('s1', makeSession('s1'));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1' });
    await router.handle({ action: 'REPLAY_FINISHED', errors: [] });
    expect((await state.get()).replay).toBeNull();
  });

  it('tolerates a non-array errors payload', async () => {
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1'));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1' });
    expect(await router.handle({ action: 'REPLAY_FINISHED', errors: null as never })).toMatchObject({
      success: true,
    });
  });

  it('refuses to step when nothing is replaying', async () => {
    const { router } = harness();
    expect(await router.handle({ action: 'STEP_REPLAY' })).toMatchObject({ success: false });
  });

  it('clamps the replay speed', async () => {
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1'));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1' });
    expect(await router.handle({ action: 'SET_REPLAY_SPEED', speed: 99 })).toMatchObject({
      success: true,
      data: { speed: 10 },
    });
  });
});

describe('session management', () => {
  it('lists summaries without events', async () => {
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1', { events: [makeEvent(0, 's1')] }));
    const result = (await router.handle({ action: 'GET_SESSIONS' })) as { sessions: SessionSummary[] };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.events).toBeUndefined();
  });

  it('returns a full session on demand', async () => {
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1', { events: [makeEvent(0, 's1')] }));
    const result = (await router.handle({ action: 'GET_SESSION', sessionId: 's1' })) as {
      session: SessionData | null;
    };
    expect(result.session?.events).toHaveLength(1);
  });

  it('requires a session id for deletes', async () => {
    const { router } = harness();
    expect(await router.handle({ action: 'DELETE_SESSION', sessionId: '' })).toMatchObject({
      success: false,
    });
  });

  it('returns session JSON for export instead of downloading in the worker', async () => {
    // MV3 workers have no URL.createObjectURL, so the download moved to the popup.
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1'));
    const result = await router.handle({ action: 'EXPORT_SESSION', sessionId: 's1' });
    expect(result).toMatchObject({ success: true });
    expect((result as { data: { session: SessionData } }).data.session.id).toBe('s1');
  });

  it('rejects an invalid import', async () => {
    const { router } = harness();
    expect(await router.handle({ action: 'IMPORT_SESSION', sessionData: { nope: true } })).toMatchObject({
      success: false,
    });
  });

  it('sanitises an imported session before storing it', async () => {
    const { router, sessions } = harness();
    const payload = makeSession('imported', {
      initialState: {
        url: 'https://example.com/',
        viewport: { width: 1, height: 1 },
        localStorage: {},
        sessionStorage: {},
        cookies: 'session=secret',
      },
    });

    expect(await router.handle({ action: 'IMPORT_SESSION', sessionData: payload })).toMatchObject({
      success: true,
    });
    expect(sessions.get('imported')?.initialState?.cookies).toBeUndefined();
  });
});

describe('GET_STATE', () => {
  it('reports an idle extension', async () => {
    const { router } = harness();
    const state = (await router.handle({ action: 'GET_STATE' })) as RuntimeState;
    expect(state).toMatchObject({
      isRecording: false,
      isReplaying: false,
      activeReplaySession: null,
      replaySpeed: 1,
    });
  });

  it('exposes the replay session and its total event count', async () => {
    const { router, sessions } = harness();
    sessions.set('s1', makeSession('s1', { events: [makeEvent(0, 's1'), makeEvent(1, 's1')] }));
    await router.handle({ action: 'REPLAY_SESSION', sessionId: 's1', speed: 3 });

    const state = (await router.handle({ action: 'GET_STATE' })) as RuntimeState;
    expect(state.isReplaying).toBe(true);
    expect(state.replayTotalEvents).toBe(2);
    expect(state.replaySpeed).toBe(3);
  });
});
