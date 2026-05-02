export type EventType =
  | 'Click'
  | 'Input'
  | 'Scroll'
  | 'Mutation'
  | 'Navigation'
  | 'Network'
  | 'Resize'
  | 'Focus'
  | 'Blur';

export interface BaseEvent {
  id: string; // Unique event ID
  sessionId: string; // Session this event belongs to
  type: EventType;
  timestamp: number; // Normalized timestamp (ms since session start)
  payload: Record<string, any>; // Event-specific data
}

export interface ClickEvent extends BaseEvent {
  type: 'Click';
  payload: {
    selector: string;
    x: number;
    y: number;
    targetTag: string;
  };
}

export interface InputEvent extends BaseEvent {
  type: 'Input';
  payload: {
    selector: string;
    value: string;
    inputType: string;
  };
}

export interface ScrollEvent extends BaseEvent {
  type: 'Scroll';
  payload: {
    selector: string;
    scrollTop: number;
    scrollLeft: number;
  };
}

export interface MutationEvent extends BaseEvent {
  type: 'Mutation';
  payload: {
    type: 'childList' | 'attributes' | 'characterData';
    targetSelector: string;
    addedNodes?: string[]; // Serialized HTML
    removedNodes?: string[];
    attributeName?: string;
    attributeValue?: string;
    oldValue?: string;
    newValue?: string;
  };
}

export interface NavigationEvent extends BaseEvent {
  type: 'Navigation';
  payload: {
    url: string;
    referrer?: string;
  };
}

export interface NetworkEvent extends BaseEvent {
  type: 'Network';
  payload: {
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    responseStatus: number;
    responseHeaders: Record<string, string>;
    responseBody: string;
  };
}

export interface ResizeEvent extends BaseEvent {
  type: 'Resize';
  payload: {
    width: number;
    height: number;
  };
}

export interface FocusEvent extends BaseEvent {
  type: 'Focus';
  payload: {
    selector: string;
  };
}

export interface BlurEvent extends BaseEvent {
  type: 'Blur';
  payload: {
    selector: string;
  };
}

export type RecordedEvent =
  | ClickEvent
  | InputEvent
  | ScrollEvent
  | MutationEvent
  | NavigationEvent
  | NetworkEvent
  | ResizeEvent
  | FocusEvent
  | BlurEvent;

export type ClickPayload = ClickEvent['payload'];
export type InputPayload = InputEvent['payload'];
export type ScrollPayload = ScrollEvent['payload'];
export type MutationPayload = MutationEvent['payload'];
export type NavigationPayload = NavigationEvent['payload'];
export type NetworkPayload = NetworkEvent['payload'];
export type ResizePayload = ResizeEvent['payload'];
export type FocusPayload = FocusEvent['payload'];
export type BlurPayload = BlurEvent['payload'];

export interface SessionData {
  id: string;
  url: string;
  startTime: number;
  events: RecordedEvent[];
  metadata: {
    userAgent: string;
    viewport: { width: number; height: number };
    totalEvents: number;
    duration: number;
  };
}

export interface ReplayState {
  isPlaying: boolean;
  currentTime: number;
  speed: number;
  paused: boolean;
}

export interface EventChunk {
  id: string;
  sessionId: string;
  chunkId: number;
  events: RecordedEvent[];
  compressed: boolean;
}
