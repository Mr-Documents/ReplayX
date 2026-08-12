/**
 * Background state that survives MV3 service-worker suspension.
 *
 * The previous implementation kept recording and replay state in module-level
 * variables. Chrome tears the worker down after ~30s idle, so a recording that
 * spanned a pause would come back with `isRecording === false` and every
 * subsequent event flush was rejected with "Session not found".
 *
 * `chrome.storage.session` is memory-backed, cleared on browser restart, and
 * not exposed to content scripts - exactly the right lifetime for this.
 */

export interface RecordingState {
  sessionId: string;
  tabId: number;
  startTime: number;
  url: string;
  isPaused: boolean;
}

export interface ReplaySessionState {
  sessionId: string;
  tabId: number;
  speed: number;
  isPaused: boolean;
  progressIndex: number;
}

export interface BackgroundState {
  recording: RecordingState | null;
  replay: ReplaySessionState | null;
}

export const EMPTY_STATE: BackgroundState = { recording: null, replay: null };

const STORAGE_KEY = 'replayx_background_state';

export interface StateStore {
  get(): Promise<BackgroundState>;
  patch(update: Partial<BackgroundState>): Promise<BackgroundState>;
  clear(): Promise<void>;
}

function areaFor(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  // `session` is unavailable in older Chrome builds; `local` is a correct,
  // slightly longer-lived fallback rather than a hard failure.
  return chrome.storage.session ?? chrome.storage.local ?? null;
}

export function createStateStore(): StateStore {
  const area = areaFor();
  // Serialises concurrent read-modify-write cycles. Two messages arriving in
  // the same tick would otherwise both read the pre-update state and the second
  // write would silently drop the first.
  let queue: Promise<BackgroundState> = Promise.resolve(EMPTY_STATE);
  let cache: BackgroundState | null = null;

  async function read(): Promise<BackgroundState> {
    if (cache) return cache;
    if (!area) {
      cache = { ...EMPTY_STATE };
      return cache;
    }
    const stored = await area.get([STORAGE_KEY]);
    const value = stored?.[STORAGE_KEY] as BackgroundState | undefined;
    cache = { recording: value?.recording ?? null, replay: value?.replay ?? null };
    return cache;
  }

  async function write(next: BackgroundState): Promise<BackgroundState> {
    cache = next;
    if (area) await area.set({ [STORAGE_KEY]: next });
    return next;
  }

  return {
    get() {
      queue = queue.then(read, read);
      return queue;
    },
    patch(update) {
      queue = queue.then(
        async () => write({ ...(await read()), ...update }),
        async () => write({ ...EMPTY_STATE, ...update }),
      );
      return queue;
    },
    async clear() {
      cache = { ...EMPTY_STATE };
      if (area) await area.remove([STORAGE_KEY]);
    },
  };
}

/** In-memory store for unit tests and non-extension contexts. */
export function createMemoryStateStore(initial: BackgroundState = EMPTY_STATE): StateStore {
  let state: BackgroundState = { ...initial };
  return {
    async get() {
      return state;
    },
    async patch(update) {
      state = { ...state, ...update };
      return state;
    },
    async clear() {
      state = { ...EMPTY_STATE };
    },
  };
}
