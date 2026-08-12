import { EVENT_TYPES, type EventType, type RecordedEvent, type SessionData } from './types';

/**
 * Schema validation and sanitisation for session data crossing a trust
 * boundary (file import, and anything replayed back into a page).
 */

const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const MAX_EVENT_COUNT = 100_000;
const MAX_PAYLOAD_BYTES = 1_000_000;
/** Cap on individual event errors so a malformed file cannot produce 100k strings. */
const MAX_REPORTED_ERRORS = 50;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

const SENSITIVE_QUERY_PARAMS = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'apikey',
  'api_key',
  'sessionid',
  'session_id',
  'auth',
  'password',
  'secret',
  'code',
  'signature',
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSessionData(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Session data must be an object'] };
  }

  const session = data as Partial<SessionData>;

  if (typeof session.id !== 'string' || session.id.length === 0) {
    errors.push('Session must have a non-empty id string');
  }

  if (typeof session.url !== 'string' || session.url.length === 0) {
    errors.push('Session must have a url string');
  } else if (!isValidUrl(session.url)) {
    errors.push('Session url must be a valid http(s) URL');
  }

  if (typeof session.startTime !== 'number' || !Number.isFinite(session.startTime)) {
    errors.push('Session must have a numeric startTime');
  }

  if (!Array.isArray(session.events)) {
    errors.push('Session must have an events array');
  } else if (session.events.length > MAX_EVENT_COUNT) {
    // Bail out before per-event validation; the array is already out of bounds
    // and walking 100k+ entries just to report the same fact is wasted work.
    errors.push(`Session has too many events (${session.events.length}, max ${MAX_EVENT_COUNT})`);
  } else {
    for (let i = 0; i < session.events.length && errors.length < MAX_REPORTED_ERRORS; i++) {
      errors.push(...validateEvent(session.events[i], i));
    }
  }

  if (!session.metadata || typeof session.metadata !== 'object') {
    errors.push('Session must have a metadata object');
  } else {
    if (typeof session.metadata.userAgent !== 'string') {
      errors.push('Session metadata must have a userAgent string');
    }
    if (!session.metadata.viewport || typeof session.metadata.viewport !== 'object') {
      errors.push('Session metadata must have a viewport object');
    }
  }

  if (errors.length === 0) {
    let size = 0;
    try {
      size = JSON.stringify(session).length;
    } catch {
      errors.push('Session data is not serialisable (it may contain cycles)');
    }
    if (size > MAX_SESSION_BYTES) {
      errors.push(
        `Session data too large (${(size / 1024 / 1024).toFixed(2)}MB, max ${MAX_SESSION_BYTES / 1024 / 1024}MB)`,
      );
    }
  }

  return { valid: errors.length === 0, errors: errors.slice(0, MAX_REPORTED_ERRORS) };
}

function validateEvent(event: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `Event ${index}:`;

  if (!event || typeof event !== 'object') return [`${prefix} must be an object`];
  const candidate = event as Partial<RecordedEvent>;

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    errors.push(`${prefix} must have a non-empty id`);
  }
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) {
    errors.push(`${prefix} must have a non-empty sessionId`);
  }
  if (typeof candidate.type !== 'string' || !isValidEventType(candidate.type)) {
    errors.push(`${prefix} has an unrecognised type`);
  }
  if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp) || candidate.timestamp < 0) {
    errors.push(`${prefix} must have a non-negative numeric timestamp`);
  }
  if (!candidate.payload || typeof candidate.payload !== 'object') {
    errors.push(`${prefix} must have a payload object`);
  } else {
    let size = 0;
    try {
      size = JSON.stringify(candidate.payload).length;
    } catch {
      errors.push(`${prefix} payload is not serialisable`);
    }
    if (size > MAX_PAYLOAD_BYTES) {
      errors.push(`${prefix} payload too large (${size} bytes, max ${MAX_PAYLOAD_BYTES})`);
    }
  }

  return errors;
}

export function isValidEventType(type: string): type is EventType {
  return EVENT_TYPE_SET.has(type);
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (url.searchParams.has(param)) url.searchParams.set(param, '*****');
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Strips credentials and caps unbounded strings before an imported session is
 * written to storage or replayed into a page.
 */
export function sanitizeSessionData(session: SessionData): SessionData {
  const sanitized: SessionData = {
    ...session,
    url: session.url ? sanitizeUrl(session.url) : session.url,
    // Replaying someone else's captured cookies into your browser is never
    // acceptable, and the previous sanitiser left them fully intact.
    initialState: session.initialState
      ? { ...session.initialState, cookies: undefined, url: sanitizeUrl(session.initialState.url ?? '') }
      : undefined,
    metadata: {
      ...session.metadata,
      cookiesCaptured: undefined,
      pageUrls: (session.metadata?.pageUrls ?? []).map(sanitizeUrl),
    },
  };

  if (Array.isArray(session.events)) {
    sanitized.events = session.events.map(
      (event) => ({ ...event, payload: sanitizePayload(event.payload) }) as RecordedEvent,
    );
  }

  return sanitized;
}

function sanitizePayload<T extends object>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;
  const sanitized = { ...payload } as Record<string, unknown>;

  if (typeof sanitized.url === 'string') sanitized.url = sanitizeUrl(sanitized.url);
  if (typeof sanitized.frameUrl === 'string') sanitized.frameUrl = sanitizeUrl(sanitized.frameUrl);
  if (typeof sanitized.textSnippet === 'string') sanitized.textSnippet = sanitized.textSnippet.slice(0, 500);
  if (typeof sanitized.value === 'string') sanitized.value = sanitized.value.slice(0, 10_000);
  if (typeof sanitized.responseBody === 'string') {
    sanitized.responseBody = sanitized.responseBody.slice(0, 200_000);
  }
  if (typeof sanitized.requestBody === 'string') {
    sanitized.requestBody = sanitized.requestBody.slice(0, 200_000);
  }

  // Authorization-style headers should never survive an export/import round trip.
  for (const key of ['requestHeaders', 'responseHeaders'] as const) {
    const headers = sanitized[key];
    if (headers && typeof headers === 'object') {
      sanitized[key] = stripSensitiveHeaders(headers as Record<string, string>);
    }
  }

  return sanitized as T;
}

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-access-token',
  'x-refresh-token',
]);

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}
