/**
 * Isolated-world content script: owns the recorder, the replayer, the on-page
 * status widget, and the bridge from the MAIN-world interceptor.
 */
import { isNetworkCapture } from '../messages';
import type { ContentRequest, StopRecordResponse } from '../messages';
import type { RecordedEvent, SessionData } from '../types';
import { generateId, Recorder } from './recorder';
import { Replayer } from './replayer';
import { REPLAYX_UI_ATTR } from './selector';

const recorder = new Recorder();
const replayer = new Replayer();

replayer.onStop = () => setWidgetState('idle');

// ---------------------------------------------------------------------------
// Status widget
// ---------------------------------------------------------------------------

type WidgetState = 'idle' | 'recording' | 'replaying';

const WIDGET_STYLES: Record<WidgetState, { color: string; title: string }> = {
  idle: { color: '#a0aec0', title: 'ReplayX - Idle' },
  recording: { color: '#e53e3e', title: 'ReplayX - Recording' },
  replaying: { color: '#38a169', title: 'ReplayX - Replaying' },
};

let widget: HTMLDivElement | null = null;
let widgetDot: HTMLDivElement | null = null;

function ensureWidget(): void {
  if (widget?.isConnected || !document.body) return;

  widget = document.createElement('div');
  // Tagged so the recorder, the replayer's stability observer, and the DOM
  // fingerprint all ignore our own UI.
  widget.setAttribute(REPLAYX_UI_ATTR, 'widget');
  Object.assign(widget.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    width: '48px',
    height: '48px',
    borderRadius: '24px',
    backgroundColor: '#1a202c',
    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    transition: 'all 0.2s',
  });

  widgetDot = document.createElement('div');
  widgetDot.setAttribute(REPLAYX_UI_ATTR, 'dot');
  Object.assign(widgetDot.style, {
    width: '16px',
    height: '16px',
    borderRadius: '8px',
    backgroundColor: WIDGET_STYLES.idle.color,
  });

  widget.appendChild(widgetDot);
  document.body.appendChild(widget);
}

function setWidgetState(state: WidgetState): void {
  ensureWidget();
  if (!widget || !widgetDot) return;
  const style = WIDGET_STYLES[state];
  widgetDot.style.backgroundColor = style.color;
  widgetDot.style.boxShadow = state === 'idle' ? 'none' : `0 0 8px ${style.color}`;
  widget.style.border = state === 'idle' ? 'none' : `2px solid ${style.color}`;
  widget.title = style.title;
}

// ---------------------------------------------------------------------------
// Startup: resume whatever the background says is in flight
// ---------------------------------------------------------------------------

function bootstrap(): void {
  ensureWidget();
  try {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
      if (chrome.runtime.lastError) {
        console.warn('[ReplayX] Background unavailable:', chrome.runtime.lastError.message);
        return;
      }
      if (!state) return;

      if (state.isRecording && state.currentSessionId) {
        recorder.start(state.currentSessionId, state.recordingStartTime ?? undefined);
        if (state.isPaused) recorder.pause();
        setWidgetState('recording');
        return;
      }

      if (state.isReplaying && state.activeReplaySession && !replayer.isActive()) {
        startReplay(state.activeReplaySession, state.replaySpeed, true, state.replayProgressIndex ?? 0);
        if (state.isReplayPaused) replayer.pause();
        return;
      }

      setWidgetState('idle');
    });
  } catch (error) {
    console.warn('[ReplayX] Bootstrap failed:', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}

function startReplay(session: SessionData, speed: number, isResume: boolean, resumeIndex: number): void {
  setWidgetState('replaying');
  void replayer.start(session, { speed: speed || 1, isResume, resumeIndex });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

/**
 * A single listener for every action. Two listeners were registered before, and
 * because the first one answered `Unknown action` for anything it did not
 * recognise, STEP_REPLAY was always rejected before the second could reply.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as ContentRequest;
  if (!request || typeof request.action !== 'string') return false;

  try {
    switch (request.action) {
      case 'START_RECORD':
        recorder.start(request.sessionId, request.sessionStartTime);
        setWidgetState('recording');
        sendResponse({ success: true, url: window.location.href, startTime: recorder.getSessionStartTime() });
        return false;

      case 'STOP_RECORD': {
        const result = recorder.stop();
        setWidgetState('idle');
        const payload: StopRecordResponse = {
          events: result.events,
          startTime: result.startTime,
          initialState: result.initialState,
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
        sendResponse({ success: true, data: payload, ...payload });
        return false;
      }

      case 'PAUSE_RECORDING':
        recorder.pause();
        sendResponse({ success: true });
        return false;

      case 'RESUME_RECORDING':
        recorder.resume();
        sendResponse({ success: true });
        return false;

      case 'START_REPLAY':
        startReplay(request.session, request.speed, false, request.resumeIndex ?? 0);
        sendResponse({ success: true });
        return false;

      case 'STOP_REPLAY':
        replayer.stop(false);
        setWidgetState('idle');
        sendResponse({ success: true });
        return false;

      case 'PAUSE_REPLAY':
        replayer.pause();
        sendResponse({ success: true });
        return false;

      case 'RESUME_REPLAY':
        replayer.resume();
        sendResponse({ success: true });
        return false;

      case 'SET_REPLAY_SPEED':
        replayer.setSpeed(request.speed);
        sendResponse({ success: true });
        return false;

      case 'STEP_REPLAY':
        void replayer.step();
        sendResponse({ success: true });
        return false;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
        return false;
    }
  } catch (error) {
    console.error(`[ReplayX] ${request.action} failed:`, error);
    sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
});

// ---------------------------------------------------------------------------
// Interceptor bridge
// ---------------------------------------------------------------------------

window.addEventListener('message', (event) => {
  // Only same-window messages are trusted; anything else is page-controlled.
  if (event.source !== window) return;
  if (!isNetworkCapture(event.data)) return;
  if (!recorder.isRecordingActive()) return;

  const capture = event.data;
  recorder.addEvent({
    id: generateId(),
    sessionId: recorder.getSessionId(),
    // The interceptor reports absolute wall-clock time; every other event is
    // relative to session start. Without this normalisation network events were
    // scheduled millions of milliseconds into the future and never replayed.
    timestamp: Math.max(0, capture.timestamp - recorder.getSessionStartTime()),
    type: 'Network',
    payload: {
      method: capture.method,
      url: capture.url,
      requestHeaders: capture.requestHeaders,
      requestBody: capture.requestBody,
      responseStatus: capture.responseStatus,
      responseHeaders: capture.responseHeaders,
      responseBody: capture.responseBody,
      duration: capture.duration,
      truncated: capture.truncated,
    },
  } as RecordedEvent);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

let flushed = false;

/** Hands the tail of the buffer to the background before the page goes away. */
function flushBeforeUnload(): void {
  if (flushed || !recorder.isRecordingActive()) return;
  flushed = true;

  const sessionId = recorder.getSessionId();
  const events = recorder.flushEvents();
  if (!sessionId || events.length === 0) return;

  try {
    chrome.runtime.sendMessage({ action: 'SAVE_RECORDING_EVENTS', sessionId, events }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* the extension context may already be gone */
  }
}

// `pagehide` fires in cases `beforeunload` does not (bfcache, mobile); both are
// registered but the guard makes the flush idempotent.
window.addEventListener('pagehide', flushBeforeUnload);
window.addEventListener('beforeunload', flushBeforeUnload);
