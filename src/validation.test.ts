import { describe, expect, it } from 'vitest';
import { isValidEventType, sanitizeSessionData, sanitizeUrl, validateSessionData } from './validation';
import type { RecordedEvent, SessionData } from './types';

function validSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-1',
    url: 'https://example.com/app',
    startTime: 1_700_000_000_000,
    events: [],
    metadata: {
      userAgent: 'test-agent',
      viewport: { width: 1280, height: 720 },
      totalEvents: 0,
      duration: 0,
      pageUrls: ['https://example.com/app'],
    },
    ...overrides,
  };
}

function validEvent(overrides: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    id: 'e-1',
    sessionId: 'session-1',
    timestamp: 0,
    type: 'Click',
    payload: { selector: '#a', x: 1, y: 2 },
    ...overrides,
  } as RecordedEvent;
}

describe('validateSessionData', () => {
  it('accepts a well-formed session', () => {
    expect(validateSessionData(validSession({ events: [validEvent()] }))).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['a number', 42],
  ])('rejects %s', (_label, input) => {
    expect(validateSessionData(input).valid).toBe(false);
  });

  it('requires an id, url, startTime, events and metadata', () => {
    const result = validateSessionData({});
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/id/);
    expect(result.errors.join(' ')).toMatch(/url/);
    expect(result.errors.join(' ')).toMatch(/startTime/);
    expect(result.errors.join(' ')).toMatch(/events/);
    expect(result.errors.join(' ')).toMatch(/metadata/);
  });

  it('rejects non-http urls', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>']) {
      expect(validateSessionData(validSession({ url })).valid).toBe(false);
    }
  });

  it('rejects an unrecognised event type', () => {
    const result = validateSessionData(
      validSession({ events: [validEvent({ type: 'Exec' as RecordedEvent['type'] })] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unrecognised type/i);
  });

  it('rejects a negative timestamp', () => {
    expect(validateSessionData(validSession({ events: [validEvent({ timestamp: -1 })] })).valid).toBe(false);
  });

  it('caps the number of reported errors', () => {
    const events = Array.from({ length: 500 }, () => ({}) as RecordedEvent);
    const result = validateSessionData(validSession({ events }));
    expect(result.valid).toBe(false);
    // A malformed file must not generate one error string per event.
    expect(result.errors.length).toBeLessThanOrEqual(50);
  });

  it('rejects an oversized event array without walking it', () => {
    // A sparse array: real length, no allocated elements to walk.
    const events = new Array(200_000) as RecordedEvent[];
    const result = validateSessionData(validSession({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/too many events/i);
  });
});

describe('isValidEventType', () => {
  it('accepts known types and rejects everything else', () => {
    expect(isValidEventType('Click')).toBe(true);
    expect(isValidEventType('Network')).toBe(true);
    expect(isValidEventType('constructor')).toBe(false);
    expect(isValidEventType('Eval')).toBe(false);
  });
});

describe('sanitizeUrl', () => {
  it('masks credential-bearing query parameters', () => {
    const result = sanitizeUrl('https://a.test/p?token=abc&id=7&api_key=k');
    expect(result).not.toContain('abc');
    expect(result).not.toContain('k&');
    expect(result).toContain('id=7');
  });

  it('leaves an unparsable url alone', () => {
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });
});

describe('sanitizeSessionData', () => {
  it('strips captured cookies from the initial state', () => {
    // Replaying someone else's session cookies into your own browser is never
    // acceptable; the previous sanitiser left them fully intact.
    const sanitized = sanitizeSessionData(
      validSession({
        initialState: {
          url: 'https://example.com/',
          viewport: { width: 1, height: 1 },
          localStorage: { a: '1' },
          sessionStorage: {},
          cookies: 'session=secret; auth=token',
        },
      }),
    );
    expect(sanitized.initialState?.cookies).toBeUndefined();
    expect(sanitized.initialState?.localStorage).toEqual({ a: '1' });
  });

  it('strips cookiesCaptured from metadata', () => {
    const session = validSession();
    session.metadata.cookiesCaptured = 'session=secret';
    expect(sanitizeSessionData(session).metadata.cookiesCaptured).toBeUndefined();
  });

  it('removes authorization headers from network payloads', () => {
    const sanitized = sanitizeSessionData(
      validSession({
        events: [
          validEvent({
            type: 'Network',
            payload: {
              method: 'GET',
              url: 'https://a.test/x?token=secret',
              requestHeaders: { Authorization: 'Bearer abc', Accept: 'application/json' },
              responseStatus: 200,
              responseHeaders: { 'Set-Cookie': 'sid=1' },
              responseBody: '{}',
            },
          }),
        ],
      }),
    );

    const payload = sanitized.events[0]!.payload as {
      requestHeaders: Record<string, string>;
      responseHeaders: Record<string, string>;
      url: string;
    };
    expect(payload.requestHeaders.Authorization).toBeUndefined();
    expect(payload.requestHeaders.Accept).toBe('application/json');
    expect(payload.responseHeaders['Set-Cookie']).toBeUndefined();
    expect(payload.url).not.toContain('secret');
  });

  it('caps unbounded string fields', () => {
    const sanitized = sanitizeSessionData(
      validSession({
        events: [
          validEvent({
            type: 'Input',
            payload: {
              selector: '#a',
              inputType: 'text',
              value: 'x'.repeat(50_000),
              textSnippet: 'y'.repeat(2_000),
            },
          }),
        ],
      }),
    );
    const payload = sanitized.events[0]!.payload as { value: string; textSnippet: string };
    expect(payload.value).toHaveLength(10_000);
    expect(payload.textSnippet).toHaveLength(500);
  });

  it('does not mutate the input session', () => {
    const session = validSession({ events: [validEvent()] });
    const before = JSON.stringify(session);
    sanitizeSessionData(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('handles a session with no events or initial state', () => {
    expect(() => sanitizeSessionData(validSession())).not.toThrow();
  });
});
