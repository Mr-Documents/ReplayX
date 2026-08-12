import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, vi } from 'vitest';

/**
 * Global test setup.
 *
 * - Provides a fresh in-memory IndexedDB per test so storage tests are isolated.
 * - Provides a minimal but faithful `chrome.*` stub. Production code always goes
 *   through `chrome.runtime.lastError` checks, so the stub models that contract.
 */

export interface ChromeStub {
  runtime: {
    id: string;
    lastError: { message: string } | undefined;
    sendMessage: ReturnType<typeof vi.fn>;
    getManifest: ReturnType<typeof vi.fn>;
    getURL: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    onUpdated: { addListener: ReturnType<typeof vi.fn> };
    onRemoved: { addListener: ReturnType<typeof vi.fn> };
  };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  storage: {
    session: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
    local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  };
  alarms: {
    create: ReturnType<typeof vi.fn>;
    onAlarm: { addListener: ReturnType<typeof vi.fn> };
  };
}

function makeStorageArea() {
  const backing = new Map<string, unknown>();
  return {
    get: vi.fn((keys: string[] | string, cb?: (items: Record<string, unknown>) => void) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (backing.has(key)) out[key] = backing.get(key);
      }
      cb?.(out);
      return Promise.resolve(out);
    }),
    set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
      cb?.();
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string[] | string, cb?: () => void) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) backing.delete(key);
      cb?.();
      return Promise.resolve();
    }),
  };
}

export function createChromeStub(): ChromeStub {
  return {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      sendMessage: vi.fn((_message: unknown, cb?: (response: unknown) => void) => {
        cb?.({ success: true });
        return Promise.resolve({ success: true });
      }),
      getManifest: vi.fn(() => ({
        content_scripts: [{ js: ['assets/main.js'] }, { js: ['assets/interceptor.js'], world: 'MAIN' }],
      })),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([{ id: 1, url: 'https://example.com/' }])),
      sendMessage: vi.fn((_tabId: number, _message: unknown, cb?: (response: unknown) => void) => {
        cb?.({ success: true });
        return Promise.resolve({ success: true });
      }),
      update: vi.fn(() => Promise.resolve({})),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(() => Promise.resolve([])) },
    storage: { session: makeStorageArea(), local: makeStorageArea() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  };
}

declare global {
  var chromeStub: ChromeStub;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  const stub = createChromeStub();
  globalThis.chromeStub = stub;
  (globalThis as unknown as { chrome: ChromeStub }).chrome = stub;
});
