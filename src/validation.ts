import { SessionData, EventType } from './types';

/**
 * Schema validation for session data to prevent security issues and data corruption
 */

const MAX_SESSION_SIZE = 50 * 1024 * 1024; // 50MB max session size
const MAX_EVENT_COUNT = 100000; // Maximum 100k events per session
const MAX_STRING_LENGTH = 1000000; // 1MB max for any string field

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSessionData(data: unknown): ValidationResult {
  const errors: string[] = [];

  // Basic structure validation
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Session data must be an object'] };
  }

  const session = data as SessionData;

  // Required fields
  if (!session.id || typeof session.id !== 'string') {
    errors.push('Session must have a valid id string');
  }

  if (!session.url || typeof session.url !== 'string') {
    errors.push('Session must have a valid url string');
  } else if (!isValidUrl(session.url)) {
    errors.push('Session url must be a valid HTTP/HTTPS URL');
  }

  if (!session.startTime || typeof session.startTime !== 'number') {
    errors.push('Session must have a valid startTime number');
  }

  if (!session.events || !Array.isArray(session.events)) {
    errors.push('Session must have an events array');
  } else {
    // Validate events
    if (session.events.length > MAX_EVENT_COUNT) {
      errors.push(`Session has too many events (${session.events.length}, max ${MAX_EVENT_COUNT})`);
    }

    for (let i = 0; i < session.events.length; i++) {
      const eventErrors = validateEvent(session.events[i], i);
      errors.push(...eventErrors);
    }
  }

  // Validate metadata
  if (!session.metadata || typeof session.metadata !== 'object') {
    errors.push('Session must have metadata object');
  } else {
    if (!session.metadata.userAgent || typeof session.metadata.userAgent !== 'string') {
      errors.push('Session metadata must have userAgent string');
    }
    if (!session.metadata.viewport || typeof session.metadata.viewport !== 'object') {
      errors.push('Session metadata must have viewport object');
    }
  }

  // Check total size
  const dataSize = JSON.stringify(session).length;
  if (dataSize > MAX_SESSION_SIZE) {
    errors.push(`Session data too large (${(dataSize / 1024 / 1024).toFixed(2)}MB, max ${MAX_SESSION_SIZE / 1024 / 1024}MB)`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateEvent(event: any, index: number): string[] {
  const errors: string[] = [];
  const prefix = `Event ${index}:`;

  if (!event || typeof event !== 'object') {
    errors.push(`${prefix} must be an object`);
    return errors;
  }

  if (!event.id || typeof event.id !== 'string') {
    errors.push(`${prefix} must have valid id string`);
  }

  if (!event.sessionId || typeof event.sessionId !== 'string') {
    errors.push(`${prefix} must have valid sessionId string`);
  }

  if (!event.type || !isValidEventType(event.type)) {
    errors.push(`${prefix} must have valid event type`);
  }

  if (typeof event.timestamp !== 'number' || event.timestamp < 0) {
    errors.push(`${prefix} must have valid timestamp number`);
  }

  if (!event.payload || typeof event.payload !== 'object') {
    errors.push(`${prefix} must have payload object`);
  } else {
    // Validate payload size
    const payloadSize = JSON.stringify(event.payload).length;
    if (payloadSize > MAX_STRING_LENGTH) {
      errors.push(`${prefix} payload too large (${payloadSize} bytes, max ${MAX_STRING_LENGTH})`);
    }
  }

  return errors;
}

function isValidEventType(type: string): type is EventType {
  const validTypes: EventType[] = [
    'Click', 'DoubleClick', 'Input', 'Change', 'Submit',
    'Scroll', 'Mutation', 'Navigation', 'Network', 'Key',
    'Resize', 'Focus', 'Blur'
  ];
  return validTypes.includes(type as EventType);
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sanitize imported session data to prevent injection attacks
 */
export function sanitizeSessionData(session: SessionData): SessionData {
  const sanitized = { ...session };

  // Sanitize URL
  if (sanitized.url) {
    try {
      const url = new URL(sanitized.url);
      // Remove sensitive query parameters
      const sensitiveParams = ['token', 'apikey', 'api_key', 'sessionid', 'auth', 'password', 'secret'];
      sensitiveParams.forEach(param => {
        if (url.searchParams.has(param)) {
          url.searchParams.set(param, '*****');
        }
      });
      sanitized.url = url.toString();
    } catch {
      // Keep original if invalid URL
    }
  }

  // Sanitize events
  if (sanitized.events) {
    sanitized.events = sanitized.events.map(event => ({
      ...event,
      payload: sanitizePayload(event.payload)
    }));
  }

  return sanitized;
}

function sanitizePayload(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const sanitized: any = { ...payload };

  // Sanitize URL fields
  if (sanitized.url) {
    try {
      const url = new URL(sanitized.url);
      const sensitiveParams = ['token', 'apikey', 'api_key', 'sessionid', 'auth', 'password', 'secret'];
      sensitiveParams.forEach(param => {
        if (url.searchParams.has(param)) {
          url.searchParams.set(param, '*****');
        }
      });
      sanitized.url = url.toString();
    } catch {
      // Keep original if invalid URL
    }
  }

  // Sanitize text snippets (limit length)
  if (sanitized.textSnippet && typeof sanitized.textSnippet === 'string') {
    sanitized.textSnippet = sanitized.textSnippet.slice(0, 500);
  }

  // Sanitize value fields (limit length)
  if (sanitized.value && typeof sanitized.value === 'string') {
    sanitized.value = sanitized.value.slice(0, 10000);
  }

  return sanitized;
}
