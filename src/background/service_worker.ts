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
  if (tabId === replayTabId && changeInfo.status === 'complete' && activeReplaySession) {
    // Give the page a slight delay to initialize scripts
    setTimeout(() => {
      if (activeReplaySession) {
        chrome.tabs.sendMessage(tabId, { action: 'START_REPLAY', session: activeReplaySession });
      }
    }, 500);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_STATE') {
    sendResponse({ isRecording, currentTabId });
  } else if (message.action === 'START_RECORDING') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab.id) {
        currentTabId = tab.id;
        isRecording = true;
        chrome.tabs.sendMessage(tab.id, { action: 'START_RECORD' }, (response) => {
            if (response && response.success) {
                recordingState.url = response.url;
                recordingState.startTime = response.startTime;
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, error: 'Could not communicate with tab' });
            }
        });
      }
    });
    return true; // async
  } else if (message.action === 'STOP_RECORDING') {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { action: 'STOP_RECORD' }, async (response) => {
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
            if (tab.id) {
                activeReplaySession = session;
                replayTabId = tab.id;
                chrome.tabs.sendMessage(tab.id, { action: 'START_REPLAY', session }, (res) => {
                     sendResponse({ success: true });
                });
            }
        });
    });
    return true;
  } else if (message.action === 'REPLAY_FINISHED') {
    activeReplaySession = null;
    replayTabId = null;
  }
});
