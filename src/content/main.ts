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

function updateWidgetState(isRecording: boolean) {
  if (!widget) createWidget();
  const icon = document.getElementById('replayx-icon-dot');
  if (icon && widget) {
    if (isRecording) {
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

// Check initial state from background in case of page refresh
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
  if (state && state.isRecording) {
    console.log('[ReplayX] Resuming recording after refresh');
    startRecordingState();
  } else if (state && state.activeReplaySession) {
    console.log('[ReplayX] Automatically starting replay after navigation');
    createWidget();
    updateWidgetState(false);
    replayer.start(state.activeReplaySession);
  } else {
    createWidget();
    updateWidgetState(false);
  }
});

function startRecordingState() {
  recorder.start();
  updateWidgetState(true);
  window.postMessage({
    source: 'replayx-content',
    action: 'SET_MODE',
    mode: 'RECORD'
  }, '*');
}

function stopRecordingState(): { events: any[], startTime: number } {
  const result = recorder.stop();
  updateWidgetState(false);
  window.postMessage({
    source: 'replayx-content',
    action: 'SET_MODE',
    mode: 'IDLE'
  }, '*');
  return result;
}

// Listen for network events from the interceptor
window.addEventListener('message', (event) => {
  if (event.data && event.data.source === 'replayx-interceptor' && event.data.type === 'Network') {
    const netEvent = event.data as NetworkEvent;
    recorder.addEvent(netEvent);
  }
});

// Listen for commands from the extension UI / background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_RECORD') {
    console.log('[ReplayX] Start Recording');
    startRecordingState();
    sendResponse({ success: true, url: window.location.href, startTime: Date.now() });
    
  } else if (message.action === 'STOP_RECORD') {
    console.log('[ReplayX] Stop Recording');
    const result = stopRecordingState();
    sendResponse({ success: true, events: result.events, startTime: result.startTime });
    
  } else if (message.action === 'START_REPLAY') {
    const session: SessionData = message.session;
    replayer.start(session);
    sendResponse({ success: true });
  }
});
