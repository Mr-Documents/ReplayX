import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStateStore, createStateStore, EMPTY_STATE } from './state';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createMemoryStateStore', () => {
  it('starts empty and applies patches', async () => {
    const store = createMemoryStateStore();
    expect(await store.get()).toEqual(EMPTY_STATE);

    await store.patch({ recording: { sessionId: 's', tabId: 1, startTime: 0, url: 'u', isPaused: false } });
    expect((await store.get()).recording?.sessionId).toBe('s');
  });

  it('leaves untouched slices alone', async () => {
    const store = createMemoryStateStore();
    await store.patch({ replay: { sessionId: 'r', tabId: 2, speed: 1, isPaused: false, progressIndex: 0 } });
    await store.patch({ recording: { sessionId: 's', tabId: 1, startTime: 0, url: 'u', isPaused: false } });

    const state = await store.get();
    expect(state.replay?.sessionId).toBe('r');
    expect(state.recording?.sessionId).toBe('s');
  });

  it('clears everything', async () => {
    const store = createMemoryStateStore();
    await store.patch({ recording: { sessionId: 's', tabId: 1, startTime: 0, url: 'u', isPaused: false } });
    await store.clear();
    expect(await store.get()).toEqual(EMPTY_STATE);
  });
});

describe('createStateStore', () => {
  it('persists through chrome.storage.session so it survives worker suspension', async () => {
    const store = createStateStore();
    await store.patch({ recording: { sessionId: 's1', tabId: 3, startTime: 9, url: 'u', isPaused: false } });

    // Module-level variables (the previous approach) are lost when MV3 recycles
    // the worker; the value must reach storage.
    expect(chromeStub.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        replayx_background_state: expect.objectContaining({
          recording: expect.objectContaining({ sessionId: 's1' }),
        }),
      }),
    );
  });

  it('rehydrates from storage in a fresh store instance', async () => {
    const first = createStateStore();
    await first.patch({ recording: { sessionId: 's1', tabId: 3, startTime: 9, url: 'u', isPaused: true } });

    // A new store models the worker coming back after being torn down.
    const second = createStateStore();
    const state = await second.get();
    expect(state.recording).toMatchObject({ sessionId: 's1', isPaused: true });
  });

  it('serialises concurrent patches so none is lost', async () => {
    const store = createStateStore();
    await Promise.all([
      store.patch({ recording: { sessionId: 'a', tabId: 1, startTime: 0, url: 'u', isPaused: false } }),
      store.patch({ replay: { sessionId: 'b', tabId: 2, speed: 2, isPaused: false, progressIndex: 3 } }),
    ]);

    const state = await store.get();
    // Unqueued read-modify-write would drop whichever patch resolved first.
    expect(state.recording?.sessionId).toBe('a');
    expect(state.replay?.sessionId).toBe('b');
  });

  it('returns an empty state when nothing is stored', async () => {
    expect(await createStateStore().get()).toEqual(EMPTY_STATE);
  });

  it('clears persisted state', async () => {
    const store = createStateStore();
    await store.patch({ replay: { sessionId: 'r', tabId: 1, speed: 1, isPaused: false, progressIndex: 0 } });
    await store.clear();
    expect(chromeStub.storage.session.remove).toHaveBeenCalled();
    expect(await store.get()).toEqual(EMPTY_STATE);
  });

  it('falls back to storage.local when session storage is unavailable', async () => {
    const original = chromeStub.storage.session;
    (chromeStub.storage as { session?: unknown }).session = undefined;

    const store = createStateStore();
    await store.patch({ recording: { sessionId: 'x', tabId: 1, startTime: 0, url: 'u', isPaused: false } });
    expect(chromeStub.storage.local.set).toHaveBeenCalled();

    (chromeStub.storage as { session?: unknown }).session = original;
  });

  it('degrades to in-memory when chrome.storage is missing entirely', async () => {
    const originalChrome = globalThis.chrome;
    (globalThis as { chrome?: unknown }).chrome = undefined;

    const store = createStateStore();
    await store.patch({ recording: { sessionId: 'mem', tabId: 1, startTime: 0, url: 'u', isPaused: false } });
    expect((await store.get()).recording?.sessionId).toBe('mem');

    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });
});
