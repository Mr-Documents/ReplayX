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

export const EVENT_TYPES: readonly EventType[] = [
  'Click',
  'DoubleClick',
  'Input',
  'Change',
  'Submit',
  'Scroll',
  'Mutation',
  'Navigation',
  'Network',
  'Key',
  'Resize',
  'Focus',
  'Blur',
] as const;

/** Every payload carries the frame it was captured in so replay never fires cross-frame. */
export interface BasePayload {
  frameUrl?: string;
}

export interface BaseEvent {
  id: string; // Unique event ID
  sessionId: string; // Session this event belongs to
  sequence?: number; // Monotonic sequence number within session
  type: EventType;
  timestamp: number; // Normalized timestamp (ms since session start)
  /** Narrowed by each concrete event type in the RecordedEvent union. */
  payload: BasePayload;
}

export interface InitialStateSnapshot {
  url: string;
  viewport: { width: number; height: number };
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  /** Never persisted for imported sessions - stripped by sanitizeSessionData. */
  cookies?: string;
}

export interface TargetPayload extends BasePayload {
  selector: string;
  fallbackSelectors?: string[];
  id?: string;
  name?: string;
  dataTestId?: string;
  targetTag?: string;
  textSnippet?: string;
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
    masked?: boolean;
  };
}

export interface ChangeEvent extends BaseEvent {
  type: 'Change';
  payload: TargetPayload & {
    value: string;
    inputType: string;
    masked?: boolean;
  };
}

export interface FormSubmitEvent extends BaseEvent {
  type: 'Submit';
  payload: TargetPayload & {
    formAction?: string;
    formMethod?: string;
  };
}

export type KeyEventKind = 'down' | 'up';

export interface KeyEvent extends BaseEvent {
  type: 'Key';
  payload: BasePayload & {
    /** Distinguishes keydown from keyup so replay does not double-fire each key. */
    kind: KeyEventKind;
    key: string;
    code?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
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
  payload: BasePayload & {
    type: 'childList' | 'attributes' | 'characterData';
    targetSelector: string;
    addedNodes?: string[]; // Serialized HTML (truncated)
    removedNodes?: string[];
    attributeName?: string;
    attributeValue?: string;
    oldValue?: string;
    newValue?: string;
  };
}

export interface NavigationEvent extends BaseEvent {
  type: 'Navigation';
  payload: BasePayload & {
    url: string;
    referrer?: string;
    navigationType?: 'navigate' | 'push' | 'replace' | 'back' | 'forward';
  };
}

export interface NetworkEvent extends BaseEvent {
  type: 'Network';
  payload: BasePayload & {
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    responseStatus: number;
    responseHeaders: Record<string, string>;
    responseBody: string;
    duration?: number;
    truncated?: boolean;
  };
}

export interface ResizeEvent extends BaseEvent {
  type: 'Resize';
  payload: BasePayload & {
    width: number;
    height: number;
  };
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
export type KeyPayload = KeyEvent['payload'];

export type ReplayErrorCode =
  | 'target_not_found'
  | 'event_failed'
  | 'step_failed'
  | 'dom_mismatch'
  | 'settle_timeout';

export interface ReplayErrorEntry {
  eventId?: string;
  eventType?: EventType;
  code?: ReplayErrorCode | string;
  message?: string;
  details?: string;
  stage?: string;
  timestamp?: number;
  dom?: string;
  selector?: string;
  retryable?: boolean;
  severity?: 'info' | 'warning' | 'error';
  targetTag?: string;
  expected?: string;
  actual?: string;
}

export interface SessionMetadata {
  userAgent: string;
  viewport: { width: number; height: number };
  totalEvents: number;
  duration: number;
  pageUrls: string[];
  cookiesCaptured?: string;
  replayIssues?: number;
}

export interface SessionData {
  id: string;
  url: string;
  startTime: number;
  endTime?: number;
  initialState?: InitialStateSnapshot;
  events: RecordedEvent[];
  metadata: SessionMetadata;
  replayErrors?: ReplayErrorEntry[];
}

/**
 * A session record without its events. The popup list only needs this, and
 * loading it avoids pulling every event of every session into memory.
 */
export type SessionSummary = Omit<SessionData, 'events'> & { events?: never };

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
