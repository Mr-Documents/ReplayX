/**
 * MAIN-world network interception for fetch and XMLHttpRequest.
 *
 * This runs inside the page's own realm on every http(s) document, so the two
 * hard requirements are: (a) never change observable behaviour when idle, and
 * (b) never throw into page code. Every hook is wrapped accordingly.
 *
 * Exported as `installInterceptor` so it can be unit tested; the module also
 * self-installs when loaded as a content script.
 */
import {
  CONTENT_SOURCE,
  INTERCEPTOR_SOURCE,
  isContentMessage,
  type InterceptorMode,
  type NetworkMock,
} from '../messages';

/** Response/request bodies above this are truncated before being stored. */
const MAX_BODY_BYTES = 128 * 1024;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'www-authenticate',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-access-token',
  'x-refresh-token',
  'x-session-id',
  'x-session-token',
  'x-authentication',
  'x-token',
  'api-key',
  'secret',
  'private-key',
  'access-token',
  'refresh-token',
  'id-token',
  'bearer',
]);

const SENSITIVE_BODY_KEYS = [
  'password',
  'passwd',
  'card',
  'cc',
  'cvv',
  'token',
  'secret',
  'apikey',
  'api_key',
  'api-key',
  'accesskey',
  'access_key',
  'access-key',
  'privatekey',
  'private_key',
  'private-key',
  'sessionid',
  'session_id',
  'session-id',
  'auth',
  'authorization',
  'bearer',
  'refresh',
  'ssn',
  'socialsecurity',
  'creditcard',
  'credit_card',
  'credit-card',
  'bankaccount',
  'bank_account',
  'bank-account',
  'pin',
  'otp',
  'totp',
  'mfa',
  '2fa',
];

const MASK = '*****';

export interface InterceptorHandle {
  uninstall(): void;
  /** Test seam - reports the mode the content script last requested. */
  getMode(): InterceptorMode;
}

export function installInterceptor(win: Window & typeof globalThis = window): InterceptorHandle {
  const marker = win as unknown as Record<string, unknown>;
  if (marker._replayx_interceptor_loaded) {
    return {
      uninstall: () => {},
      getMode: () => (marker._replayx_interceptor_mode as InterceptorMode) ?? 'IDLE',
    };
  }
  marker._replayx_interceptor_loaded = true;

  let mode: InterceptorMode = 'IDLE';
  let replayNetworkEvents: NetworkMock[] = [];
  const consumedEventIds = new Set<string>();
  let requestCounter = 0;

  const originalFetch = win.fetch;
  const XHR = win.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetRequestHeader = XHR.prototype.setRequestHeader;

  function setMode(next: InterceptorMode) {
    mode = next;
    marker._replayx_interceptor_mode = next;
  }

  function post(message: Record<string, unknown>) {
    try {
      win.postMessage({ source: INTERCEPTOR_SOURCE, ...message }, '*');
    } catch {
      /* postMessage can throw on non-cloneable payloads; never break the page */
    }
  }

  function lifecycle(
    action: 'NETWORK_REQUEST_STARTED' | 'NETWORK_REQUEST_FINISHED' | 'NETWORK_REQUEST_FAILED',
    requestId: string,
  ) {
    post({ action, requestId });
  }

  const onMessage = (event: MessageEvent) => {
    // Only trust same-window messages; anything from a frame or opener is page-controlled.
    if (event.source !== win) return;
    if (!isContentMessage(event.data)) return;
    setMode(event.data.mode);
    if (event.data.mode === 'REPLAY') {
      replayNetworkEvents = Array.isArray(event.data.networkEvents) ? event.data.networkEvents : [];
      consumedEventIds.clear();
      console.info('[ReplayX Interceptor] Loaded', replayNetworkEvents.length, 'network mocks');
    } else {
      replayNetworkEvents = [];
      consumedEventIds.clear();
    }
  };
  win.addEventListener('message', onMessage);

  // -------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------

  const patchedFetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Fast path: when idle we must be completely transparent.
    if (mode === 'IDLE') return originalFetch.call(win, input, init);

    const url = resolveUrl(input);
    const method = resolveMethod(input, init);
    const requestId = `fetch-${++requestCounter}`;
    const startedAt = Date.now();
    const startedPerf = now();

    if (mode === 'REPLAY') {
      lifecycle('NETWORK_REQUEST_STARTED', requestId);
      try {
        const requestBody = await extractRequestBody(input, init);
        const mock = findMatchingNetworkEvent(method, url, requestBody);
        if (mock) {
          post({ action: 'MOCK_CONSUMED', id: mock.id });
          return createMockResponse(mock);
        }
        console.warn(`[ReplayX] No mock for ${method} ${url}; passing through`);
      } finally {
        lifecycle('NETWORK_REQUEST_FINISHED', requestId);
      }
      return originalFetch.call(win, input, init);
    }

    // RECORD
    lifecycle('NETWORK_REQUEST_STARTED', requestId);
    let response: Response;
    try {
      response = await originalFetch.call(win, input, init);
    } catch (error) {
      // Without this the pending-request counter leaks upward and every
      // subsequent replay settle waits for the full timeout.
      lifecycle('NETWORK_REQUEST_FAILED', requestId);
      throw error;
    }

    try {
      const clone = response.clone();
      const requestHeaders = extractHeaders(input instanceof Request ? input.headers : init?.headers);
      const requestBody = await extractRequestBody(input, init);
      const responseHeaders: Record<string, string> = {};
      clone.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const rawResponseBody = await clone.text();
      const body = truncate(rawResponseBody);

      post({
        action: 'NETWORK_CAPTURED',
        timestamp: startedAt,
        duration: Math.round(now() - startedPerf),
        method,
        url,
        requestHeaders: sanitizeHeaders(requestHeaders),
        requestBody: sanitizeBody(truncate(requestBody ?? '').value),
        responseStatus: response.status,
        responseHeaders: sanitizeHeaders(responseHeaders),
        responseBody: sanitizeBody(body.value),
        truncated: body.truncated,
      });
    } catch (error) {
      console.warn('[ReplayX] Failed to record fetch:', error);
    } finally {
      lifecycle('NETWORK_REQUEST_FINISHED', requestId);
    }

    return response;
  };
  win.fetch = patchedFetch as typeof win.fetch;

  // -------------------------------------------------------------------------
  // XMLHttpRequest
  // -------------------------------------------------------------------------

  interface XhrRecord {
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    startedAt: number;
    startedPerf: number;
  }
  const xhrRecords = new WeakMap<XMLHttpRequest, XhrRecord>();

  XHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    xhrRecords.set(this, {
      method: String(method || 'GET').toUpperCase(),
      url: typeof url === 'string' ? url : String(url),
      requestHeaders: {},
      startedAt: Date.now(),
      startedPerf: now(),
    });
    // The previous implementation forwarded only `rest`, dropping `method` and
    // `url` entirely, which broke every XHR on every page the extension touched.
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.prototype.open;

  XHR.prototype.setRequestHeader = function (this: XMLHttpRequest, header: string, value: string) {
    const record = xhrRecords.get(this);
    if (record) record.requestHeaders[header] = value;
    return originalSetRequestHeader.call(this, header, value);
  };

  XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const record = xhrRecords.get(this);
    if (!record || mode === 'IDLE') return originalSend.call(this, body ?? null);

    record.requestBody = stringifyXhrBody(body);
    record.startedAt = Date.now();
    record.startedPerf = now();
    const requestId = `xhr-${++requestCounter}`;

    if (mode === 'REPLAY') {
      lifecycle('NETWORK_REQUEST_STARTED', requestId);
      const mock = findMatchingNetworkEvent(record.method, record.url, record.requestBody);
      if (mock) {
        post({ action: 'MOCK_CONSUMED', id: mock.id });
        mockXhrResponse(this, mock, () => lifecycle('NETWORK_REQUEST_FINISHED', requestId));
        return undefined;
      }
      console.warn(`[ReplayX] No mock for XHR ${record.method} ${record.url}; passing through`);
      lifecycle('NETWORK_REQUEST_FINISHED', requestId);
      return originalSend.call(this, body ?? null);
    }

    // RECORD - `loadend` fires for success, error, abort and timeout alike, and
    // unlike assigning `onreadystatechange` it cannot be clobbered by page code.
    lifecycle('NETWORK_REQUEST_STARTED', requestId);
    captureOnLoadEnd(this, record, requestId);
    return originalSend.call(this, body ?? null);
  };

  function captureOnLoadEnd(xhr: XMLHttpRequest, record: XhrRecord, requestId: string): void {
    const onLoadEnd = () => {
      xhr.removeEventListener('loadend', onLoadEnd);
      // status 0 means aborted, timed out, or a network/CORS failure. It settles
      // the request exactly once, so no FINISHED may follow.
      if (xhr.status === 0) {
        lifecycle('NETWORK_REQUEST_FAILED', requestId);
        return;
      }
      try {
        const body = truncate(readXhrText(xhr));
        post({
          action: 'NETWORK_CAPTURED',
          timestamp: record.startedAt,
          duration: Math.round(now() - record.startedPerf),
          method: record.method,
          url: record.url,
          requestHeaders: sanitizeHeaders(record.requestHeaders),
          requestBody: sanitizeBody(truncate(record.requestBody ?? '').value),
          responseStatus: xhr.status,
          responseHeaders: sanitizeHeaders(parseResponseHeaders(xhr.getAllResponseHeaders())),
          responseBody: sanitizeBody(body.value),
          truncated: body.truncated,
        });
      } catch (error) {
        console.warn('[ReplayX] Failed to record XHR:', error);
      } finally {
        lifecycle('NETWORK_REQUEST_FINISHED', requestId);
      }
    };
    xhr.addEventListener('loadend', onLoadEnd);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function now(): number {
    return typeof win.performance?.now === 'function' ? win.performance.now() : Date.now();
  }

  function resolveUrl(input: RequestInfo | URL): string {
    try {
      if (typeof input === 'string') return new URL(input, win.location.href).href;
      if (input instanceof URL) return input.href;
      return new URL(input.url, win.location.href).href;
    } catch {
      return typeof input === 'string' ? input : String(input);
    }
  }

  function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return String(method).toUpperCase();
  }

  function findMatchingNetworkEvent(method: string, url: string, body?: string): NetworkMock | undefined {
    let fullUrl: string;
    try {
      fullUrl = new URL(url, win.location.href).href;
    } catch {
      fullUrl = url;
    }
    const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const bodyMatches = (event: NetworkMock) => !isMutation || !body || event.requestBody === body;

    let match = replayNetworkEvents.find(
      (event) =>
        !consumedEventIds.has(event.id) &&
        event.method === method &&
        event.url === fullUrl &&
        bodyMatches(event),
    );

    if (!match) {
      const cleanUrl = stripQuery(fullUrl);
      match = replayNetworkEvents.find(
        (event) =>
          !consumedEventIds.has(event.id) &&
          event.method === method &&
          stripQuery(event.url) === cleanUrl &&
          bodyMatches(event),
      );
    }

    if (match) consumedEventIds.add(match.id);
    return match;
  }

  function createMockResponse(event: NetworkMock): Response {
    const status = event.responseStatus || 200;
    // `new Response(body, { status: 204 })` throws for null-body statuses.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : event.responseBody, {
      status,
      statusText: status >= 400 ? 'Error' : 'OK',
      headers: event.responseHeaders ?? {},
    });
  }

  function mockXhrResponse(xhr: XMLHttpRequest, event: NetworkMock, onComplete: () => void) {
    const headers = event.responseHeaders ?? {};
    let responseValue: unknown = event.responseBody;
    if (xhr.responseType === 'json') {
      try {
        responseValue = JSON.parse(event.responseBody);
      } catch {
        responseValue = null;
      }
    }

    const define = (prop: string, value: unknown) => {
      try {
        Object.defineProperty(xhr, prop, { value, writable: false, configurable: true });
      } catch {
        /* some hosts seal XHR instances; the remaining fields still apply */
      }
    };

    define('status', event.responseStatus || 200);
    define('statusText', (event.responseStatus || 200) >= 400 ? 'Error' : 'OK');
    define('responseText', xhr.responseType === '' || xhr.responseType === 'text' ? event.responseBody : '');
    define('response', responseValue);
    define('readyState', 4);
    define('responseURL', event.url);

    xhr.getAllResponseHeaders = () =>
      Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') + '\r\n';
    xhr.getResponseHeader = (header: string) => {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === header.toLowerCase());
      return key ? (headers[key] ?? null) : null;
    };

    // Real XHR completes asynchronously; libraries rely on that ordering.
    win.setTimeout(() => {
      try {
        dispatch(xhr, new Event('readystatechange'));
        xhr.onreadystatechange?.call(xhr, new Event('readystatechange'));
        const progressInit = { lengthComputable: false, loaded: 0, total: 0 };
        dispatch(xhr, new ProgressEvent('load', progressInit));
        xhr.onload?.call(xhr, new ProgressEvent('load', progressInit));
        // Omitting `loadend` strands any library that only listens for it.
        dispatch(xhr, new ProgressEvent('loadend', progressInit));
        xhr.onloadend?.call(xhr, new ProgressEvent('loadend', progressInit));
      } catch (error) {
        console.warn('[ReplayX] Mock XHR dispatch failed:', error);
      } finally {
        onComplete();
      }
    }, 0);
  }

  function dispatch(xhr: XMLHttpRequest, event: Event) {
    try {
      xhr.dispatchEvent(event);
    } catch {
      /* ignore listener errors raised by page code */
    }
  }

  function uninstall() {
    win.removeEventListener('message', onMessage);
    win.fetch = originalFetch;
    XHR.prototype.open = originalOpen;
    XHR.prototype.send = originalSend;
    XHR.prototype.setRequestHeader = originalSetRequestHeader;
    delete marker._replayx_interceptor_loaded;
    delete marker._replayx_interceptor_mode;
  }

  console.info('[ReplayX] Network interceptor initialised');
  return { uninstall, getMode: () => mode };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function truncate(value: string, limit = MAX_BODY_BYTES): { value: string; truncated: boolean } {
  if (typeof value !== 'string' || value.length <= limit) return { value: value ?? '', truncated: false };
  return { value: `${value.slice(0, limit)}…[truncated]`, truncated: true };
}

export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_BODY_KEYS.some(
    (candidate) =>
      lower === candidate ||
      lower.includes(candidate) ||
      lower.startsWith(`${candidate}_`) ||
      lower.endsWith(`_${candidate}`),
  );
}

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? MASK : maskValue(nested);
    }
    return out;
  }
  return value;
}

/** Masks credential-shaped fields in JSON and urlencoded bodies. */
export function sanitizeBody(body: string | undefined): string {
  if (!body) return body ?? '';
  const trimmed = body.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(maskValue(JSON.parse(trimmed)));
    } catch {
      return body;
    }
  }

  // application/x-www-form-urlencoded was previously left completely unmasked.
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
    try {
      const params = new URLSearchParams(trimmed);
      const out = new URLSearchParams();
      for (const [key, value] of params) out.append(key, isSensitiveKey(key) ? MASK : value);
      return out.toString();
    } catch {
      return body;
    }
  }

  return body;
}

export function extractHeaders(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) result[String(entry[0])] = String(entry[1]);
    }
  } else {
    for (const [key, value] of Object.entries(headers)) result[key] = String(value);
  }
  return result;
}

export function parseResponseHeaders(headerString: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headerString) return headers;
  for (const line of headerString.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return headers;
}

function formDataToJson(form: FormData): string {
  const data: Record<string, string> = {};
  for (const [key, value] of form as unknown as Iterable<[string, FormDataEntryValue]>) {
    data[key] = typeof value === 'string' ? value : `[file:${value.name}]`;
  }
  return JSON.stringify(data);
}

function stringifyXhrBody(body?: Document | XMLHttpRequestBodyInit | null): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return formDataToJson(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
  try {
    return String(body);
  } catch {
    return undefined;
  }
}

export async function extractRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | undefined> {
  try {
    if (typeof Request !== 'undefined' && input instanceof Request && !init?.body) {
      return await input.clone().text();
    }
    const body = init?.body;
    if (!body) return undefined;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) return formDataToJson(body);
    if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer as ArrayBuffer);
  } catch {
    /* an unreadable body must never fail the request */
  }
  return undefined;
}

function readXhrText(xhr: XMLHttpRequest): string {
  try {
    // Reading `responseText` throws when responseType is set to anything else.
    if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText ?? '';
    if (xhr.responseType === 'json') return JSON.stringify(xhr.response ?? null);
    return '';
  } catch {
    return '';
  }
}

export { CONTENT_SOURCE, INTERCEPTOR_SOURCE };
