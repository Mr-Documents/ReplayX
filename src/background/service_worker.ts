import { saveSession, getSessions, getSession } from '../storage/db';
import { SessionData, RecordedEvent } from '../types';

let isRecording = false;
let currentTabId: number | null = null;
let currentRecordingEvents: RecordedEvent[] = [];
let recordingState = {
  url: '',
  startTime: 0
};

let activeReplaySession: SessionData | null = null;
let replayTabId: number | null = null;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if tab finished loading and we have an active replay session
  if (changeInfo.status === 'complete' && tabId === replayTabId && activeReplaySession) {
    console.log('[ReplayX] Tab navigation complete, starting replay');
    chrome.tabs.sendMessage(tabId, { action: 'START_REPLAY', session: activeReplaySession }, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[ReplayX] Auto-replay start error:', chrome.runtime.lastError.message);
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_STATE') {
    sendResponse({ 
      isRecording, 
      currentTabId,
      activeReplaySession: (replayTabId && sender.tab && replayTabId === sender.tab.id) ? activeReplaySession : null
    });
  } else if (message.action === 'START_RECORDING') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        currentTabId = tab.id;
        isRecording = true;
        chrome.tabs.sendMessage(tab.id, { action: 'START_RECORD' }, (response) => {
            if (chrome.runtime.lastError) {
                isRecording = false;
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            if (response && response.success) {
                recordingState.url = response.url;
                recordingState.startTime = response.startTime;
                sendResponse({ success: true });
            } else {
                isRecording = false;
                sendResponse({ success: false, error: 'Could not communicate with tab' });
            }
        });
      } else {
        sendResponse({ success: false, error: 'No active tab found' });
      }
    });
    return true; // async
  } else if (message.action === 'STOP_RECORDING') {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { action: 'STOP_RECORD' }, async (response) => {
        if (chrome.runtime.lastError) {
            console.error('Stop recording error:', chrome.runtime.lastError.message);
        }
        isRecording = false;
        if (response && response.success) {
          const session: SessionData = {
            id: crypto.randomUUID(),
            url: recordingState.url,
            startTime: response.startTime,
            events: response.events
          };
          await saveSession(session);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false });
        }
      });
      return true; // async
    } else {
      sendResponse({ success: false });
    }
  } else if (message.action === 'GET_SESSIONS') {
    getSessions().then(sessions => sendResponse({ sessions }));
    return true; // async
  } else if (message.action === 'REPLAY_SESSION') {
    const sessionId = message.sessionId;
    getSession(sessionId).then(session => {
        if (!session) return sendResponse({ success: false });
        
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (tab && tab.id) {
                activeReplaySession = session;
                replayTabId = tab.id;
                
                // Compare URLs safely, ignore trailing slashes or hashes for basic match if needed, but strict is fine for now
                let tabUrlObj, sessionUrlObj;
                try {
                   tabUrlObj = new URL(tab.url || '');
                   sessionUrlObj = new URL(session.url);
                } catch(e) {}

                // If completely different origin or pathname, navigate
                if (tabUrlObj && sessionUrlObj && (tabUrlObj.origin !== sessionUrlObj.origin || tabUrlObj.pathname !== sessionUrlObj.pathname)) {
                     chrome.tabs.update(tab.id, { url: session.url }, () => {
                         // Navigation started, but we need to wait for it to complete
                         // The content script will check for activeReplaySession and auto-start
                         sendResponse({ success: true });
                     });
                } else {
                    chrome.tabs.sendMessage(tab.id, { action: 'START_REPLAY', session }, (res) => {
                         if (chrome.runtime.lastError) {
                             console.error('Replay start error:', chrome.runtime.lastError.message);
                         }
                         sendResponse({ success: true });
                    });
                }
            } else {
                sendResponse({ success: false });
            }
        });
    });
    return true;
  } else if (message.action === 'REPLAY_FINISHED') {
    activeReplaySession = null;
    replayTabId = null;
  }
});
