export type EventType =
  | 'Click'
  | 'DoubleClick'
  | 'Input'
  | 'Change'
  | 'Submit'
  | 'Scroll'
  | 'Mutation'
  | 'Navigation'
  | 'Network'
  | 'Key'
  | 'Resize'
  | 'Focus'
  | 'Blur';

export interface BaseEvent {
  id: string; // Unique event ID
  sessionId: string; // Session this event belongs to
  sequence?: number; // Monotonic sequence number within session
  type: EventType;
  timestamp: number; // Normalized timestamp (ms since session start)
  payload: Record<string, any>; // Event-specific data
}

export interface InitialStateSnapshot {
  url: string;
  viewport: { width: number; height: number };
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies?: string;
}

export interface TargetPayload {
  selector: string;
  fallbackSelectors?: string[];
  id?: string;
  name?: string;
  dataTestId?: string;
  targetTag?: string;
  textSnippet?: string;
  frameUrl?: string;
}

export interface ClickEvent extends BaseEvent {
  type: 'Click';
  payload: TargetPayload & {
    x: number;
    y: number;
    dbl?: boolean;
  };
}

export interface DoubleClickEvent extends BaseEvent {
  type: 'DoubleClick';
  payload: ClickEvent['payload'];
}

export interface InputEvent extends BaseEvent {
  type: 'Input';
  payload: TargetPayload & {
    value: string;
    inputType: string;
  };
}

export interface ChangeEvent extends BaseEvent {
  type: 'Change';
  payload: TargetPayload & {
    value: string;
    inputType: string;
  };
}

export interface FormSubmitEvent extends BaseEvent {
  type: 'Submit';
  payload: TargetPayload & {
    formAction?: string;
    formMethod?: string;
  };
}

export interface KeyEvent extends BaseEvent {
  type: 'Key';
  payload: {
    key: string;
    code?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    frameUrl?: string;
  };
}

export interface ScrollEvent extends BaseEvent {
  type: 'Scroll';
  payload: TargetPayload & {
    scrollTop: number;
    scrollLeft: number;
  };
}

export interface FocusEvent extends BaseEvent {
  type: 'Focus';
  payload: TargetPayload;
}

export interface BlurEvent extends BaseEvent {
  type: 'Blur';
  payload: TargetPayload;
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
    frameUrl?: string;
  };
}

export interface NavigationEvent extends BaseEvent {
  type: 'Navigation';
  payload: {
    url: string;
    referrer?: string;
    frameUrl?: string;
    navigationType?: 'navigate' | 'push' | 'replace' | 'back' | 'forward';
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
    duration?: number;
    frameUrl?: string;
  };
}

export interface ResizeEvent extends BaseEvent {
  type: 'Resize';
  payload: {
    width: number;
    height: number;
    frameUrl?: string;
  };
}

export interface FocusEvent extends BaseEvent {
  type: 'Focus';
  payload: TargetPayload;
}

export interface BlurEvent extends BaseEvent {
  type: 'Blur';
  payload: TargetPayload;
}

export type RecordedEvent =
  | ClickEvent
  | DoubleClickEvent
  | InputEvent
  | ChangeEvent
  | FormSubmitEvent
  | ScrollEvent
  | MutationEvent
  | NavigationEvent
  | NetworkEvent
  | KeyEvent
  | ResizeEvent
  | FocusEvent
  | BlurEvent;

export type ClickPayload = ClickEvent['payload'];
export type InputPayload = InputEvent['payload'];
export type ChangePayload = ChangeEvent['payload'];
export type SubmitPayload = FormSubmitEvent['payload'];
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
  endTime?: number;
  initialState?: InitialStateSnapshot;
  events: RecordedEvent[];
  metadata: {
    userAgent: string;
    viewport: { width: number; height: number };
    totalEvents: number;
    duration: number;
    pageUrls: string[];
    cookiesCaptured?: string;
    replayIssues?: number;
  };
  replayErrors?: Array<{
    eventId?: string;
    eventType?: EventType;
    code?: string;
    message?: string;
    details?: string;
    stage?: string;
    error?: string;
    timestamp?: number;
    dom?: string;
  }>;
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
