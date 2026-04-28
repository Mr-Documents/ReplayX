import { Recorder } from './recorder';
import { Replayer } from './replayer';
import { SessionData, NetworkEvent } from '../types';
// In Vite CRXJS, we can get the URL of an injected script via ?script
import interceptorUrl from './interceptor?script';

const recorder = new Recorder();
const replayer = new Replayer();

let currentSessionId: string | null = null;
let currentURL: string = window.location.href;

// Inject the interceptor into the MAIN world
function injectInterceptor() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(interceptorUrl);
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// Start injection right away so it can be idle
injectInterceptor();

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
    recorder.start();
    
    // Set interceptor to record
    window.postMessage({
      source: 'replayx-content',
      action: 'SET_MODE',
      mode: 'RECORD'
    }, '*');
    
    sendResponse({ success: true, url: window.location.href, startTime: Date.now() });
    
  } else if (message.action === 'STOP_RECORD') {
    console.log('[ReplayX] Stop Recording');
    const { events, startTime } = recorder.stop();
    
    // Set interceptor to idle
    window.postMessage({
      source: 'replayx-content',
      action: 'SET_MODE',
      mode: 'IDLE'
    }, '*');

    sendResponse({ success: true, events, startTime });
    
  } else if (message.action === 'START_REPLAY') {
    const session: SessionData = message.session;
    // We navigate to the start URL if we aren't there yet (this check is usually handled by background script before injecting, but we confirm here)
    if (window.location.href !== session.url) {
       console.log('[ReplayX] Navigating to initial URL before replay...');
       window.location.href = session.url;
       // the replay will need to be re-triggered by the bg script once page loads!
       sendResponse({ success: true, navigating: true });
       return;
    }
    
    replayer.start(session);
    sendResponse({ success: true });
  }
});
