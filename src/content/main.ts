import { Recorder } from './recorder';
import { Replayer } from './replayer';
import { SessionData } from '../types';

const recorder = new Recorder();
const replayer = new Replayer();

// Sync widget state when replay finishes naturally
replayer.onStop = () => updateWidgetState(false);

// Create floating widget
let widget: HTMLDivElement | null = null;

function createWidget() {
  // Guard: Ensure body exists and widget isn't already there
  if (widget || !document.body) return;

  widget = document.createElement('div');
  widget.id = 'replayx-widget';
  widget.style.position = 'fixed';
  widget.style.bottom = '20px';
  widget.style.right = '20px';
  widget.style.width = '48px';
  widget.style.height = '48px';
  widget.style.borderRadius = '24px';
  widget.style.backgroundColor = '#1a202c';
  widget.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.3)';
  widget.style.zIndex = '999999';
  widget.style.display = 'flex';
  widget.style.alignItems = 'center';
  widget.style.justifyContent = 'center';
  widget.style.cursor = 'pointer';
  widget.style.transition = 'all 0.2s';
  widget.title = 'ReplayX - Idle';

  const icon = document.createElement('div');
  icon.id = 'replayx-icon-dot';
  icon.style.width = '16px';
  icon.style.height = '16px';
  icon.style.borderRadius = '8px';
  icon.style.backgroundColor = '#a0aec0'; // Idle color
  widget.appendChild(icon);

  document.body.appendChild(widget);

  widget.addEventListener('click', () => {
    // Optional: could toggle recording from here, or just open popup.
  });
}

function updateWidgetState(isRecording: boolean, isReplaying: boolean = false) {
  if (!widget) createWidget();
  const icon = document.getElementById('replayx-icon-dot');
  if (icon && widget) {
    if (isReplaying) {
      icon.style.backgroundColor = '#38a169'; // Green for replaying
      icon.style.boxShadow = '0 0 8px #38a169';
      widget.title = 'ReplayX - Replaying';
      widget.style.border = '2px solid #38a169';
    } else if (isRecording) {
      icon.style.backgroundColor = '#e53e3e'; // Red for recording
      icon.style.boxShadow = '0 0 8px #e53e3e';
      widget.title = 'ReplayX - Recording';
      widget.style.border = '2px solid #e53e3e';
    } else {
      icon.style.backgroundColor = '#a0aec0';
      icon.style.boxShadow = 'none';
      widget.title = 'ReplayX - Idle';
      widget.style.border = 'none';
    }
  }
}

// Inject immediately at document_start (via manifest) to catch early API calls
injectInterceptor();

/**
 * Injects the interceptor into the Main World.
 * Content scripts in Isolated Worlds cannot patch window.fetch.
 */
function injectInterceptor() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('dist/content/interceptor.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// Check initial state from background in case of page refresh or navigation
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state: any) => {
  if (chrome.runtime.lastError) {
    console.warn('[ReplayX] Could not connect to background script:', chrome.runtime.lastError.message);
    return;
  }

  createWidget();

  if (state?.isRecording && state?.currentSessionId) {
    console.log('[ReplayX] Resuming recording after navigation or refresh');
    recorder.start(state.currentSessionId, state.recordingStartTime);
    if (state.isPaused) recorder.pause();
    updateWidgetState(true);
  } else if (state?.activeReplaySession && !replayer.isActive()) {
    console.log('[ReplayX] Automatically resuming replay after navigation');
    startReplaySession(state.activeReplaySession, state.replaySpeed, true, state.replayProgressIndex || 0);
    if (state.isReplayPaused) replayer.pause();
  } else {
    updateWidgetState(false);
  }
});

// Message handlers
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Return true to keep message channel open for async responses
  switch (message.action) {
    case 'START_RECORD':
      try {
        recorder.start(message.sessionId);
        updateWidgetState(true);
        const startTime = recorder.getSessionStartTime();
        sendResponse({
          success: true,
          url: window.location.href,
          startTime
        });
      } catch (error) {
        console.error('[ReplayX] Error starting recording:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'STOP_RECORD':
      try {
        const result = recorder.stop();
        updateWidgetState(false);
        sendResponse({
          success: true,
          events: result.events,
          startTime: result.startTime,
          initialState: result.initialState,
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight }
        });
      } catch (error) {
        console.error('[ReplayX] Error stopping recording:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'PAUSE_RECORDING':
      try {
        recorder.pause();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'RESUME_RECORDING':
      try {
        recorder.resume();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'START_REPLAY':
      try {
        // allow resumeIndex when starting replay from a specific event
        startReplaySession(message.session, message.speed, false, message.resumeIndex || 0);
        sendResponse({ success: true });
      } catch (error) {
        console.error('[ReplayX] Error starting replay:', error);
        updateWidgetState(false);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'STOP_REPLAY':
      try {
        replayer.stop();
        updateWidgetState(false);
        sendResponse({ success: true });
      } catch (error) {
        console.error('[ReplayX] Error stopping replay:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'PAUSE_REPLAY':
      try {
        replayer.pause();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'RESUME_REPLAY':
      try {
        replayer.resume();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    case 'SET_REPLAY_SPEED':
      try {
        replayer.setSpeed(message.speed);
        sendResponse({ success: true });
      } catch (error) {
        console.error('[ReplayX] Error setting replay speed:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      break;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
  return true;
});

// Support stepping the replay from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse): boolean => {
  if (message.action === 'STEP_REPLAY') {
    try {
      replayer.step();
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  return false;
});

/**
 * Shared helper to start replay and update UI
 */
function startReplaySession(session: SessionData, speed: number, isResume: boolean = false, resumeIndex: number = 0) {
  updateWidgetState(false, true);
  replayer.start(session, { speed: speed || 1, isResume, resumeIndex });
}

// Handle network events from interceptor
window.addEventListener('message', (event) => {
  if (event.data && event.data.source === 'replayx-interceptor' && event.data.type === 'Network') {
    // Forward network events to recorder
    recorder.addEvent({
      id: (function() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
          return crypto.randomUUID();
        }
        return Math.random().toString(36).substring(2);
      })(),
      sessionId: recorder.getSessionId() || 'unknown',
      type: 'Network',
      timestamp: event.data.timestamp,
      payload: {
        method: event.data.method,
        url: event.data.url,
        requestHeaders: event.data.requestHeaders,
        requestBody: event.data.requestBody,
        responseStatus: event.data.responseStatus,
        responseHeaders: event.data.responseHeaders,
        responseBody: event.data.responseBody
      }
    });
  }
});

// Error handling
window.addEventListener('error', (event) => {
  console.error('[ReplayX] Content script error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[ReplayX] Unhandled promise rejection:', event.reason);
});

// Cleanup on page unload
function flushRecordingState() {
  if (!recorder.isRecordingActive()) {
    return;
  }

  const sessionId = recorder.getSessionId();
  const sessionStartTime = recorder.getSessionStartTime();
  const result = recorder.stop();

  if (sessionId && result.events.length) {
    chrome.runtime.sendMessage({
      action: 'SAVE_RECORDING_EVENTS',
      sessionId,
      events: result.events,
      sessionStartTime,
      initialState: result.initialState
    });
  }
}

window.addEventListener('pagehide', flushRecordingState);
window.addEventListener('beforeunload', flushRecordingState);
