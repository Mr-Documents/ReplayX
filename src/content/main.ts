import { Recorder } from './recorder';
import { Replayer } from './replayer';
import { SessionData, NetworkEvent } from '../types';

const recorder = new Recorder();
const replayer = new Replayer();

// Create floating widget
let widget: HTMLDivElement | null = null;

function createWidget() {
  if (widget) return;
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

// Check initial state from background in case of page refresh or navigation
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
  createWidget();

  if (state?.isRecording && state?.currentSessionId) {
    console.log('[ReplayX] Resuming recording after navigation or refresh');
    recorder.start(state.currentSessionId, state.recordingStartTime);
    updateWidgetState(true);
  } else if (state?.activeReplaySession) {
    console.log('[ReplayX] Automatically starting replay after navigation');
    updateWidgetState(false, true);
    replayer.start(state.activeReplaySession, { speed: state.replaySpeed || 1 });
  } else {
    updateWidgetState(false);
  }
});

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'START_RECORD':
      try {
        recorder.start(message.sessionId);
        updateWidgetState(true);
        sendResponse({
          success: true,
          url: window.location.href,
          startTime: Date.now()
        });
      } catch (error) {
        console.error('[ReplayX] Error starting recording:', error);
        sendResponse({ success: false, error: error.message });
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
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight }
        });
      } catch (error) {
        console.error('[ReplayX] Error stopping recording:', error);
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'START_REPLAY':
      try {
        updateWidgetState(false, true);
        replayer.start(message.session, { speed: message.speed || 1 });
        sendResponse({ success: true });
      } catch (error) {
        console.error('[ReplayX] Error starting replay:', error);
        updateWidgetState(false);
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'STOP_REPLAY':
      try {
        replayer.stop();
        updateWidgetState(false);
        sendResponse({ success: true });
      } catch (error) {
        console.error('[ReplayX] Error stopping replay:', error);
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'SET_REPLAY_SPEED':
      try {
        replayer.setSpeed(message.speed);
        sendResponse({ success: true });
      } catch (error) {
        console.error('[ReplayX] Error setting replay speed:', error);
        sendResponse({ success: false, error: error.message });
      }
      break;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
});

// Handle network events from interceptor
window.addEventListener('message', (event) => {
  if (event.data && event.data.source === 'replayx-interceptor' && event.data.type === 'Network') {
    // Forward network events to recorder
    recorder.addEvent({
      id: crypto.randomUUID(),
      sessionId: recorder['sessionId'] || 'unknown', // Access private property for now
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
      sessionStartTime
    });
  }
}

window.addEventListener('pagehide', flushRecordingState);
window.addEventListener('beforeunload', flushRecordingState);
window.addEventListener('unload', () => {
  if (replayer) replayer.stop();
});

// Listen for network events from the interceptor
window.addEventListener('message', (event) => {
  if (event.data && event.data.source === 'replayx-interceptor' && event.data.type === 'Network') {
    const netEvent = event.data as NetworkEvent;
    recorder.addEvent(netEvent);
  }
});
