import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractHeaders,
  extractRequestBody,
  installInterceptor,
  parseResponseHeaders,
  sanitizeBody,
  sanitizeHeaders,
  stripQuery,
  truncate,
  type InterceptorHandle,
} from './interceptor';
import type { NetworkCapture, NetworkMock } from '../messages';

let handle: InterceptorHandle | null = null;

function setMode(mode: 'IDLE' | 'RECORD' | 'REPLAY', networkEvents?: NetworkMock[]): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'replayx-content', action: 'SET_MODE', mode, networkEvents },
      source: window,
    }),
  );
}

function capturedMessages(spy: { mock: { calls: unknown[][] } }): NetworkCapture[] {
  return spy.mock.calls
    .map((call) => call[0] as NetworkCapture)
    .filter((message) => message?.action === 'NETWORK_CAPTURED');
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>)._replayx_interceptor_loaded;
  delete (window as unknown as Record<string, unknown>)._replayx_interceptor_mode;
});

afterEach(() => {
  handle?.uninstall();
  handle = null;
});

describe('installation', () => {
  it('is idempotent', () => {
    handle = installInterceptor(window);
    const second = installInterceptor(window);
    expect(second.getMode()).toBe('IDLE');
    second.uninstall();
  });

  it('restores the original globals on uninstall', () => {
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const local = installInterceptor(window);
    expect(window.fetch).not.toBe(originalFetch);
    local.uninstall();
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
  });

  it('ignores SET_MODE messages that did not come from this window', () => {
    handle = installInterceptor(window);
    // The host page shares this window, so cross-window messages are untrusted.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'replayx-content', action: 'SET_MODE', mode: 'RECORD' },
        source: null,
      }),
    );
    expect(handle.getMode()).toBe('IDLE');
  });

  it('accepts SET_MODE from this window', () => {
    handle = installInterceptor(window);
    setMode('RECORD');
    expect(handle.getMode()).toBe('RECORD');
  });
});

describe('XMLHttpRequest.open', () => {
  it('forwards the method and url to the original implementation', () => {
    // The previous build forwarded only the trailing args, so `open` was
    // effectively called with no method and no url - breaking every XHR on
    // every page the extension ran on.
    const original = vi.fn();
    const proto = XMLHttpRequest.prototype as unknown as { open: unknown };
    const saved = proto.open;
    proto.open = original;

    handle = installInterceptor(window);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/things', true);

    expect(original).toHaveBeenCalledWith('POST', 'https://api.example.com/things', true);
    handle.uninstall();
    proto.open = saved;
  });

  it('preserves async, user and password arguments', () => {
    const original = vi.fn();
    const proto = XMLHttpRequest.prototype as unknown as { open: unknown };
    const saved = proto.open;
    proto.open = original;

    handle = installInterceptor(window);
    new XMLHttpRequest().open('GET', '/x', false, 'user', 'pass');

    expect(original).toHaveBeenCalledWith('GET', '/x', false, 'user', 'pass');
    handle.uninstall();
    proto.open = saved;
  });
});

describe('fetch in IDLE mode', () => {
  it('passes straight through without emitting anything', async () => {
    const original = vi.fn(async () => new Response('ok', { status: 200 }));
    window.fetch = original as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    const response = await window.fetch('https://example.com/api');

    expect(await response.text()).toBe('ok');
    expect(original).toHaveBeenCalledOnce();
    expect(capturedMessages(posted)).toHaveLength(0);
  });
});

describe('fetch in RECORD mode', () => {
  it('captures the exchange and still returns a readable response', async () => {
    window.fetch = (async () =>
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    setMode('RECORD');

    const response = await window.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
    // The response body must remain consumable by the page.
    expect(await response.text()).toBe('{"ok":true}');

    const [capture] = capturedMessages(posted);
    expect(capture).toBeDefined();
    expect(capture!.method).toBe('POST');
    expect(capture!.url).toBe('https://example.com/api');
    expect(capture!.responseStatus).toBe(201);
    expect(capture!.responseBody).toBe('{"ok":true}');
    expect(typeof capture!.timestamp).toBe('number');
  });

  it('reports a failure so the pending-request count cannot leak', async () => {
    // Without this the replayer's settle logic waited the full timeout after
    // every failed request for the rest of the session.
    window.fetch = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    setMode('RECORD');

    await expect(window.fetch('https://example.com/api')).rejects.toThrow('network down');

    const actions = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actions).toContain('NETWORK_REQUEST_STARTED');
    expect(actions).toContain('NETWORK_REQUEST_FAILED');
  });

  it('balances started and finished for a successful request', async () => {
    window.fetch = (async () => new Response('x')) as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    setMode('RECORD');
    await window.fetch('https://example.com/api');

    const actions = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actions.filter((a) => a === 'NETWORK_REQUEST_STARTED')).toHaveLength(1);
    expect(actions.filter((a) => a === 'NETWORK_REQUEST_FINISHED')).toHaveLength(1);
  });
});

describe('fetch in REPLAY mode', () => {
  const mock: NetworkMock = {
    id: 'net-1',
    method: 'GET',
    url: 'https://example.com/api/items',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"items":[1,2]}',
  };

  it('serves a recorded response without hitting the network', async () => {
    const original = vi.fn();
    window.fetch = original as unknown as typeof window.fetch;

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);

    const response = await window.fetch('https://example.com/api/items');
    expect(original).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [1, 2] });
  });

  it('consumes each mock only once', async () => {
    const original = vi.fn(async () => new Response('live'));
    window.fetch = original as unknown as typeof window.fetch;

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);

    await window.fetch('https://example.com/api/items');
    await window.fetch('https://example.com/api/items');

    expect(original).toHaveBeenCalledOnce();
  });

  it('matches ignoring the query string when the exact url misses', async () => {
    const original = vi.fn(async () => new Response('live'));
    window.fetch = original as unknown as typeof window.fetch;

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);

    const response = await window.fetch('https://example.com/api/items?page=2');
    expect(original).not.toHaveBeenCalled();
    expect(await response.text()).toBe('{"items":[1,2]}');
  });

  it('falls through to the network when nothing matches', async () => {
    const original = vi.fn(async () => new Response('live'));
    window.fetch = original as unknown as typeof window.fetch;

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);

    const response = await window.fetch('https://example.com/other');
    expect(original).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('live');
  });

  it('settles an unmocked request only after the real response arrives', async () => {
    // Signalling FINISHED before awaiting the pass-through let the replayer see
    // the network as idle while a request was still in flight.
    let resolveFetch: (response: Response) => void = () => {};
    window.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);

    const pending = window.fetch('https://example.com/unmocked');
    await Promise.resolve();

    const actionsMidFlight = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actionsMidFlight).toContain('NETWORK_REQUEST_STARTED');
    expect(actionsMidFlight).not.toContain('NETWORK_REQUEST_FINISHED');

    resolveFetch(new Response('live'));
    await pending;

    const actionsAfter = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actionsAfter).toContain('NETWORK_REQUEST_FINISHED');
  });

  it('settles an unmocked failure exactly once', async () => {
    window.fetch = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);

    await expect(window.fetch('https://example.com/unmocked')).rejects.toThrow('offline');

    const actions = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actions.filter((a) => a === 'NETWORK_REQUEST_FAILED')).toHaveLength(1);
    // A FAILED followed by a FINISHED would decrement the pending count twice.
    expect(actions).not.toContain('NETWORK_REQUEST_FINISHED');
  });

  it('settles a served mock exactly once', async () => {
    window.fetch = (async () => new Response('live')) as unknown as typeof window.fetch;
    const posted = vi.spyOn(window, 'postMessage');

    handle = installInterceptor(window);
    setMode('REPLAY', [mock]);
    await window.fetch('https://example.com/api/items');

    const actions = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actions.filter((a) => a === 'NETWORK_REQUEST_STARTED')).toHaveLength(1);
    expect(actions.filter((a) => a === 'NETWORK_REQUEST_FINISHED')).toHaveLength(1);
  });

  it('does not throw building a mock for a null-body status', async () => {
    window.fetch = (async () => new Response('live')) as unknown as typeof window.fetch;
    handle = installInterceptor(window);
    setMode('REPLAY', [{ ...mock, responseStatus: 204, responseBody: '' }]);

    const response = await window.fetch('https://example.com/api/items');
    expect(response.status).toBe(204);
  });
});

describe('sanitizeHeaders', () => {
  it('drops credential-bearing headers', () => {
    const result = sanitizeHeaders({
      Authorization: 'Bearer abc',
      Cookie: 'sid=1',
      'X-API-Key': 'k',
      'Content-Type': 'application/json',
    });
    expect(result).toEqual({ 'Content-Type': 'application/json' });
  });

  it('is case insensitive', () => {
    expect(sanitizeHeaders({ AUTHORIZATION: 'x' })).toEqual({});
  });

  it('tolerates an empty input', () => {
    expect(sanitizeHeaders({})).toEqual({});
  });
});

describe('sanitizeBody', () => {
  it('masks sensitive JSON fields at any depth', () => {
    const masked = JSON.parse(
      sanitizeBody('{"user":{"name":"ada","password":"x","nested":{"api_key":"y"}},"ok":true}'),
    );
    expect(masked.user.name).toBe('ada');
    expect(masked.user.password).toBe('*****');
    expect(masked.user.nested.api_key).toBe('*****');
    expect(masked.ok).toBe(true);
  });

  it('masks inside arrays', () => {
    const masked = JSON.parse(sanitizeBody('[{"token":"a"},{"token":"b"}]'));
    expect(masked).toEqual([{ token: '*****' }, { token: '*****' }]);
  });

  it('masks urlencoded bodies', () => {
    // Form-encoded bodies were previously stored completely unmasked.
    const masked = sanitizeBody('username=ada&password=hunter2');
    expect(masked).toContain('username=ada');
    expect(masked).not.toContain('hunter2');
  });

  it('returns malformed JSON unchanged rather than throwing', () => {
    expect(sanitizeBody('{not json')).toBe('{not json');
  });

  it('passes through empty input', () => {
    expect(sanitizeBody(undefined)).toBe('');
  });
});

describe('pure helpers', () => {
  it('truncates oversized bodies and flags it', () => {
    const result = truncate('x'.repeat(200), 50);
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBeLessThan(80);
    expect(truncate('short', 50)).toEqual({ value: 'short', truncated: false });
  });

  it('strips query and hash', () => {
    expect(stripQuery('https://a.test/p?x=1#y')).toBe('https://a.test/p');
    expect(stripQuery('https://a.test/p')).toBe('https://a.test/p');
  });

  it('parses response header blocks', () => {
    expect(parseResponseHeaders('Content-Type: text/html\r\nX-Trace: abc\r\n')).toEqual({
      'Content-Type': 'text/html',
      'X-Trace': 'abc',
    });
    expect(parseResponseHeaders('')).toEqual({});
  });

  it('extracts headers from every accepted shape', () => {
    expect(extractHeaders({ A: '1' })).toEqual({ A: '1' });
    expect(extractHeaders([['B', '2']])).toEqual({ B: '2' });
    expect(extractHeaders(new Headers({ c: '3' }))).toEqual({ c: '3' });
    expect(extractHeaders()).toEqual({});
  });

  it('extracts request bodies from strings and URLSearchParams', async () => {
    expect(await extractRequestBody('/x', { body: 'raw' })).toBe('raw');
    expect(await extractRequestBody('/x', { body: new URLSearchParams({ a: '1' }) })).toBe('a=1');
    expect(await extractRequestBody('/x')).toBeUndefined();
  });
});

describe('host page containment', () => {
  /**
   * These hooks sit in front of every request the page makes. Shipping a throw
   * here is how the extension previously broke XHR across the whole web, so the
   * invariant is absolute: the native call always goes through.
   */

  /** A url object whose stringification throws, as exotic host objects can. */
  const hostileUrl = () =>
    ({
      toString() {
        throw new Error('hostile url');
      },
    }) as unknown as URL;

  it('still opens the request when tracking throws', () => {
    const original = vi.fn();
    const proto = XMLHttpRequest.prototype as unknown as { open: unknown };
    const saved = proto.open;
    proto.open = original;

    handle = installInterceptor(window);
    const xhr = new XMLHttpRequest();
    const url = hostileUrl();

    expect(() => xhr.open('GET', url)).not.toThrow();
    // The page's call reached the native implementation untouched.
    expect(original).toHaveBeenCalledWith('GET', url);

    handle.uninstall();
    proto.open = saved;
  });

  it('still sets the header when tracking throws', () => {
    const original = vi.fn();
    const proto = XMLHttpRequest.prototype as unknown as { setRequestHeader: unknown };
    const saved = proto.setRequestHeader;
    proto.setRequestHeader = original;

    handle = installInterceptor(window);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/x');

    expect(() => xhr.setRequestHeader('Accept', 'application/json')).not.toThrow();
    expect(original).toHaveBeenCalledWith('Accept', 'application/json');

    handle.uninstall();
    proto.setRequestHeader = saved;
  });

  it('still sends when the request body cannot be serialised', () => {
    const original = vi.fn();
    const proto = XMLHttpRequest.prototype as unknown as { send: unknown };
    const saved = proto.send;
    proto.send = original;

    handle = installInterceptor(window);
    setMode('RECORD');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/x');
    const hostileBody = {
      toString() {
        throw new Error('hostile body');
      },
    } as unknown as XMLHttpRequestBodyInit;

    expect(() => xhr.send(hostileBody)).not.toThrow();
    expect(original).toHaveBeenCalledWith(hostileBody);

    handle.uninstall();
    proto.send = saved;
  });

  it('is fully transparent to send while idle', () => {
    const original = vi.fn();
    const proto = XMLHttpRequest.prototype as unknown as { send: unknown };
    const saved = proto.send;
    proto.send = original;

    handle = installInterceptor(window);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/x');
    xhr.send();

    expect(original).toHaveBeenCalledOnce();

    handle.uninstall();
    proto.send = saved;
  });

  it('does not settle an unmocked XHR before its real response arrives', () => {
    const proto = XMLHttpRequest.prototype as unknown as { send: unknown };
    const saved = proto.send;
    proto.send = vi.fn();

    const posted = vi.spyOn(window, 'postMessage');
    handle = installInterceptor(window);
    setMode('REPLAY', []);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://example.com/unmocked');
    xhr.send();

    const midFlight = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(midFlight).toContain('NETWORK_REQUEST_STARTED');
    expect(midFlight).not.toContain('NETWORK_REQUEST_FINISHED');

    // The real response arriving is what settles it.
    Object.defineProperty(xhr, 'status', { configurable: true, value: 200 });
    xhr.dispatchEvent(new Event('loadend'));

    const after = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(after).toContain('NETWORK_REQUEST_FINISHED');

    handle.uninstall();
    proto.send = saved;
  });

  it('reports a failed pass-through XHR as failed, not finished', () => {
    const proto = XMLHttpRequest.prototype as unknown as { send: unknown };
    const saved = proto.send;
    proto.send = vi.fn();

    const posted = vi.spyOn(window, 'postMessage');
    handle = installInterceptor(window);
    setMode('REPLAY', []);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://example.com/unmocked');
    xhr.send();
    // status 0 is an abort, timeout, or network/CORS failure.
    Object.defineProperty(xhr, 'status', { configurable: true, value: 0 });
    xhr.dispatchEvent(new Event('loadend'));

    const actions = posted.mock.calls.map(([m]) => (m as { action?: string })?.action);
    expect(actions).toContain('NETWORK_REQUEST_FAILED');
    expect(actions).not.toContain('NETWORK_REQUEST_FINISHED');

    handle.uninstall();
    proto.send = saved;
  });
});
