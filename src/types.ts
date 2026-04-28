export type EventType = 'Click' | 'Input' | 'Network' | 'Navigation';

export interface BaseEvent {
  type: EventType;
  timestamp: number; // performance.now() relative to session start
}

export interface ClickEvent extends BaseEvent {
  type: 'Click';
  selector: string;
}

export interface InputEvent extends BaseEvent {
  type: 'Input';
  selector: string;
  value: string;
}

export interface NetworkEvent extends BaseEvent {
  type: 'Network';
  method: string;
  url: string;
  requestBody?: string | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  // Unique ID so we can match requests/responses easily if needed, but synchronous replay handles order.
}

export interface NavigationEvent extends BaseEvent {
  type: 'Navigation';
  url: string;
}

export type RecordedEvent = ClickEvent | InputEvent | NetworkEvent | NavigationEvent;

export interface SessionData {
  id: string; // uuid
  url: string; // The URL where recording started
  startTime: number; // Date.now() timestamp when recording started
  events: RecordedEvent[];
}
