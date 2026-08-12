/**
 * The single source of truth for every message that crosses a process boundary.
 *
 * Three distinct channels exist and must not be confused:
 *  1. popup/content -> background   (chrome.runtime.sendMessage)
 *  2. background     -> content     (chrome.tabs.sendMessage)
 *  3. content       <-> interceptor (window.postMessage, MAIN world bridge)
 *
 * Channel 3 is reachable by the host page, so every message on it is treated as
 * untrusted input and validated by `isInterceptorMessage` / `isContentMessage`.
 */
import type {
  InitialStateSnapshot,
  RecordedEvent,
  ReplayErrorEntry,
  SessionData,
  SessionSummary,
} from './types';

// ---------------------------------------------------------------------------
// Generic response envelope
// ---------------------------------------------------------------------------

export interface Ok<T = unknown> {
  success: true;
  data?: T;
}

export interface Err {
  success: false;
  error: string;
}

export type Result<T = unknown> = Ok<T> | Err;

export const ok = <T>(data?: T): Ok<T> => (data === undefined ? { success: true } : { success: true, data });
export const err = (error: string): Err => ({ success: false, error });

// ---------------------------------------------------------------------------
// Channel 1: popup / content script -> background service worker
// ---------------------------------------------------------------------------

export type BackgroundRequest =
  | { action: 'GET_STATE' }
  | { action: 'START_RECORDING' }
  | { action: 'STOP_RECORDING' }
  | { action: 'PAUSE_RECORDING' }
  | { action: 'RESUME_RECORDING' }
  | {
      action: 'SAVE_RECORDING_EVENTS';
      sessionId: string;
      events: RecordedEvent[];
      initialState?: InitialStateSnapshot;
    }
  | { action: 'GET_SESSIONS' }
  | { action: 'GET_SESSION'; sessionId: string }
  | { action: 'DELETE_SESSION'; sessionId: string }
  | { action: 'EXPORT_SESSION'; sessionId: string }
  | { action: 'IMPORT_SESSION'; sessionData: unknown }
  | { action: 'REPLAY_SESSION'; sessionId: string; speed?: number; startIndex?: number; step?: boolean }
  | { action: 'STOP_REPLAY' }
  | { action: 'PAUSE_REPLAY' }
  | { action: 'RESUME_REPLAY' }
  | { action: 'SET_REPLAY_SPEED'; speed: number }
  | { action: 'STEP_REPLAY' }
  | { action: 'UPDATE_REPLAY_PROGRESS'; sessionId: string; progressIndex: number }
  | { action: 'REPLAY_FINISHED'; errors: ReplayErrorEntry[] };

export type BackgroundAction = BackgroundRequest['action'];

export interface RuntimeState {
  isRecording: boolean;
  isPaused: boolean;
  currentSessionId: string | null;
  recordingStartTime: number | null;
  currentTabId: number | null;
  isReplaying: boolean;
  isReplayPaused: boolean;
  activeReplaySession: SessionData | null;
  replaySpeed: number;
  replayProgressIndex: number;
  replayTotalEvents: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

// ---------------------------------------------------------------------------
// Channel 2: background -> content script
// ---------------------------------------------------------------------------

export type ContentRequest =
  | { action: 'START_RECORD'; sessionId: string; sessionStartTime?: number }
  | { action: 'STOP_RECORD' }
  | { action: 'PAUSE_RECORDING' }
  | { action: 'RESUME_RECORDING' }
  | { action: 'START_REPLAY'; session: SessionData; speed: number; resumeIndex?: number }
  | { action: 'STOP_REPLAY' }
  | { action: 'PAUSE_REPLAY' }
  | { action: 'RESUME_REPLAY' }
  | { action: 'SET_REPLAY_SPEED'; speed: number }
  | { action: 'STEP_REPLAY' };

export type ContentAction = ContentRequest['action'];

export interface StopRecordResponse {
  events: RecordedEvent[];
  startTime: number;
  initialState: InitialStateSnapshot | null;
  url: string;
  viewport: { width: number; height: number };
}

// ---------------------------------------------------------------------------
// Channel 3: content <-> MAIN-world interceptor (window.postMessage)
// ---------------------------------------------------------------------------

export const INTERCEPTOR_SOURCE = 'replayx-interceptor' as const;
export const CONTENT_SOURCE = 'replayx-content' as const;

export type InterceptorMode = 'IDLE' | 'RECORD' | 'REPLAY';

/** Network shape shared with the interceptor for replay matching. */
export interface NetworkMock {
  id: string;
  method: string;
  url: string;
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export type ContentToInterceptorMessage = {
  source: typeof CONTENT_SOURCE;
  action: 'SET_MODE';
  mode: InterceptorMode;
  networkEvents?: NetworkMock[];
};

export interface NetworkCapture {
  source: typeof INTERCEPTOR_SOURCE;
  action: 'NETWORK_CAPTURED';
  /** Absolute wall-clock ms (Date.now). The content script normalises it. */
  timestamp: number;
  duration: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  truncated: boolean;
}

export interface NetworkLifecycle {
  source: typeof INTERCEPTOR_SOURCE;
  action: 'NETWORK_REQUEST_STARTED' | 'NETWORK_REQUEST_FINISHED' | 'NETWORK_REQUEST_FAILED' | 'MOCK_CONSUMED';
  requestId?: string;
  id?: string;
}

export type InterceptorToContentMessage = NetworkCapture | NetworkLifecycle;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Guards a message claiming to come from the MAIN-world interceptor.
 * The host page shares this window, so `event.source === window` is enforced by
 * the caller and the shape is checked here.
 */
export function isInterceptorMessage(data: unknown): data is InterceptorToContentMessage {
  return isRecord(data) && data.source === INTERCEPTOR_SOURCE && typeof data.action === 'string';
}

export function isNetworkCapture(data: unknown): data is NetworkCapture {
  return (
    isInterceptorMessage(data) &&
    data.action === 'NETWORK_CAPTURED' &&
    typeof (data as NetworkCapture).url === 'string' &&
    typeof (data as NetworkCapture).method === 'string'
  );
}

export function isContentMessage(data: unknown): data is ContentToInterceptorMessage {
  return (
    isRecord(data) &&
    data.source === CONTENT_SOURCE &&
    data.action === 'SET_MODE' &&
    (data.mode === 'IDLE' || data.mode === 'RECORD' || data.mode === 'REPLAY')
  );
}
