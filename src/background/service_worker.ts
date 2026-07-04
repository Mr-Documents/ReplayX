import { saveSession, getSessions, getSession, deleteSession } from '../storage/db';
import { SessionData, RecordedEvent } from '../types';

// Recording state
let isRecording = false;
let currentTabId: number | null = null;
let currentSessionId: string | null = null;
let recordingStartTime: number = 0;
let isPaused = false;

// Replay state
let activeReplaySession: SessionData | null = null;
let activeReplaySessionId: string | null = null;
let replayTabId: number | null = null;
let replaySpeed = 1;
let isReplayPaused = false;
let replayProgressIndex = 0;

const REPLAY_STATE_KEY = 'replayx_replay_state';

interface PersistedReplayState {
  sessionId: string;
  tabId: number;
  speed: number;
  isReplayPaused: boolean;
  eventIndex: number;
}

// Session lifecycle management
const sessionStates = new Map<string, {
  status: 'recording' | 'paused' | 'completed' | 'replaying';
  tabId: number;
  startTime: number;
  url: string;
  events: RecordedEvent[];
}>();

// Tab lifecycle listeners
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Navigation is now driven by the content script "pulling" state via GET_STATE 
  // on load, which is more reliable than pushing state from here.
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTabState(tabId);
});

function persistReplayState() {
  if (!activeReplaySessionId || replayTabId === null) return;

  const state: PersistedReplayState = {
    sessionId: activeReplaySessionId,
    tabId: replayTabId,
    speed: replaySpeed,
    isReplayPaused,
    eventIndex: replayProgressIndex
  };

  chrome.storage.local.set({ [REPLAY_STATE_KEY]: state }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[ReplayX BG] Failed to persist replay state:', chrome.runtime.lastError.message);
    }
  });
}

function clearPersistedReplayState() {
  activeReplaySessionId = null;
  replayProgressIndex = 0;
  chrome.storage.local.remove([REPLAY_STATE_KEY], () => {
    if (chrome.runtime.lastError) {
      console.warn('[ReplayX BG] Failed to clear replay state:', chrome.runtime.lastError.message);
    }
  });
}

chrome.storage.local.get([REPLAY_STATE_KEY], (result) => {
  const state = result[REPLAY_STATE_KEY] as PersistedReplayState | undefined;
  if (state) {
    activeReplaySessionId = state.sessionId;
    replayTabId = state.tabId;
    replaySpeed = state.speed || 1;
    isReplayPaused = state.isReplayPaused || false;
    replayProgressIndex = state.eventIndex || 0;
    console.log('[ReplayX BG] Restored persisted replay state for session:', state.sessionId);
  }
});

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.action) {
    case 'GET_STATE': {
      // If called from popup (no tabId), return global state
      // If called from content script, return tab-specific state
      const isFromPopup = !tabId;
      const isCurrentTabRecording = tabId !== undefined && tabId === currentTabId;
      const isCurrentReplayTab = tabId !== undefined && tabId === replayTabId;

      const respond = (session: SessionData | null) => {
        sendResponse({
          isRecording: isFromPopup ? isRecording : (isCurrentTabRecording ? isRecording : false),
          currentSessionId: isFromPopup ? currentSessionId : (isCurrentTabRecording ? currentSessionId : null),
          recordingStartTime: isFromPopup ? recordingStartTime : (isCurrentTabRecording ? recordingStartTime : null),
          currentTabId: isFromPopup ? currentTabId : (isCurrentTabRecording ? currentTabId : null),
          isPaused: isFromPopup ? isPaused : (isCurrentTabRecording ? isPaused : false),
          isReplayPaused: isFromPopup ? isReplayPaused : (isCurrentReplayTab ? isReplayPaused : false),
          activeReplaySession: isFromPopup ? activeReplaySession : (isCurrentReplayTab ? session : null),
          replaySpeed,
          replayProgressIndex: isCurrentReplayTab ? replayProgressIndex : 0
        });
      };

      if (!activeReplaySession && activeReplaySessionId) {
        getSession(activeReplaySessionId).then((session) => {
          activeReplaySession = session;
          respond(session);
        }).catch((error) => {
          console.warn('[ReplayX BG] Failed to restore active replay session:', error);
          respond(null);
        });
        return true;
      }

      respond(activeReplaySession);
      break;
    }
    case 'UPDATE_REPLAY_PROGRESS':
      if (message.sessionId === activeReplaySessionId) {
        replayProgressIndex = Number(message.progressIndex) || 0;
        persistReplayState();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Replay state mismatch' });
      }
      break;

    case 'SAVE_RECORDING_EVENTS':
      handleSaveRecordingEvents(message.sessionId, message.events, sendResponse);
      return true;

    case 'START_RECORDING':
      handleStartRecording(sendResponse);
      return true; // async

    case 'STOP_RECORDING':
      handleStopRecording(sendResponse);
      return true; // async

    case 'PAUSE_RECORDING':
      if (isRecording && currentSessionId && currentTabId) {
        sessionStates.get(currentSessionId)!.status = 'paused';
        isPaused = true;
        chrome.tabs.sendMessage(currentTabId, { action: 'PAUSE_RECORDING' });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not recording' });
      }
      break;

    case 'RESUME_RECORDING':
      if (isRecording && currentSessionId && currentTabId && isPaused) {
        sessionStates.get(currentSessionId)!.status = 'recording';
        isPaused = false;
        chrome.tabs.sendMessage(currentTabId, { action: 'RESUME_RECORDING' });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Cannot resume' });
      }
      break;

    case 'GET_SESSIONS':
      getSessions().then(sessions => sendResponse({ sessions })).catch(error => {
        console.error('[ReplayX BG] Error getting sessions:', error);
        sendResponse({ sessions: [], error: error.message });
      });
      return true; // async

    case 'GET_SESSION':
      if (!message.sessionId) {
        sendResponse({ success: false, error: 'Missing sessionId' });
        return;
      }
      getSession(message.sessionId).then(session => sendResponse({ success: true, session })).catch(error => {
        console.error('[ReplayX BG] Error getting session:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true;

    case 'REPLAY_SESSION':
      handleReplaySession(message.sessionId, message.speed || 1, sendResponse, message.startIndex, message.step);
      return true; // async

    case 'STOP_REPLAY':
      handleStopReplay(sendResponse);
      return true; // async

    case 'PAUSE_REPLAY':
      if (replayTabId) {
        isReplayPaused = true;
        chrome.tabs.sendMessage(replayTabId, { action: 'PAUSE_REPLAY' });
      }
      sendResponse({ success: true });
      break;

    case 'RESUME_REPLAY':
      if (replayTabId) {
        isReplayPaused = false;
        chrome.tabs.sendMessage(replayTabId, { action: 'RESUME_REPLAY' });
      }
      sendResponse({ success: true });
      break;

    case 'SET_REPLAY_SPEED':
      replaySpeed = Math.max(0.1, Math.min(10, message.speed || 1));
      if (replayTabId) {
        chrome.tabs.sendMessage(replayTabId, { action: 'SET_REPLAY_SPEED', speed: replaySpeed });
      }
      sendResponse({ success: true });
      break;

    case 'STEP_REPLAY':
      if (replayTabId) {
        chrome.tabs.sendMessage(replayTabId, { action: 'STEP_REPLAY' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[ReplayX BG] STEP_REPLAY failed to send:', chrome.runtime.lastError.message);
          }
        });
      }
      sendResponse({ success: true });
      break;

    case 'DELETE_SESSION':
      deleteSession(message.sessionId).then(() => sendResponse({ success: true })).catch(error => {
        console.error('[ReplayX BG] Error deleting session:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true; // async

    case 'EXPORT_SESSION':
      handleExportSession(message.sessionId, sendResponse);
      return true; // async

    case 'IMPORT_SESSION':
      handleImportSession(message.sessionData, sendResponse);
      return true; // async

    case 'REPLAY_FINISHED':
      console.log('[ReplayX BG] Replay finished');
      const errors = message.errors || [];
      if (activeReplaySessionId) {
        getSession(activeReplaySessionId).then((session) => {
          if (session) {
            session.metadata.replayIssues = errors.length;
            session.replayErrors = errors.map((err: any) => ({
              eventId: err.event?.id || '',
              eventType: err.event?.type || 'Unknown',
              code: err.code,
              message: err.message,
              details: err.details,
              stage: err.stage,
              error: err.message || err.details || 'Replay failed',
              timestamp: err.timestamp || err.event?.timestamp || Date.now(),
              dom: err.dom
            }));
            saveSession(session).catch((saveError) => {
              console.warn('[ReplayX BG] Failed to save replay errors:', saveError);
            });
          }
        }).catch((loadError) => {
          console.warn('[ReplayX BG] Failed to load session for replay finish:', loadError);
        });
      }
      activeReplaySession = null;
      activeReplaySessionId = null;
      replayTabId = null;
      isReplayPaused = false;
      clearPersistedReplayState();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
});

// Recording handlers
function getContentScriptPath() {
  const manifest = chrome.runtime.getManifest();
  if (!manifest.content_scripts) return null;

  const mainScript = manifest.content_scripts
    .flatMap((entry: any) => entry.js || [])
    .find((path: string) => path.includes('main')); 

  return mainScript || null;
}

async function ensureContentScript(tabId: number) {
  const scriptPath = getContentScriptPath();
  if (!scriptPath) {
    console.warn('[ReplayX BG] Cannot resolve content script path from manifest');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptPath]
    });
  } catch (error) {
    console.warn('[ReplayX BG] Could not inject main content script:', error);
  }
}

async function sendMessageToTab(tabId: number, message: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

async function handleStartRecording(sendResponse: (response: any) => void) {
  if (isRecording) {
    sendResponse({ success: false, error: 'Already recording' });
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id) {
    sendResponse({ success: false, error: 'No active tab found' });
    return;
  }

  if (!tab.url || !tab.url.startsWith('http')) {
    sendResponse({ success: false, error: 'Cannot record this tab type' });
    return;
  }

  try {
    currentSessionId = crypto.randomUUID();
    currentTabId = tab.id;
    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();

    sessionStates.set(currentSessionId, {
      status: 'recording',
      tabId: tab.id,
      startTime: recordingStartTime,
      url: tab.url || '',
      events: []
    });

    let response = await sendMessageToTab(tab.id, {
      action: 'START_RECORD',
      sessionId: currentSessionId
    });

    if (response?.error && response.error.includes('Receiving end does not exist')) {
      await ensureContentScript(tab.id);
      response = await sendMessageToTab(tab.id, {
        action: 'START_RECORD',
        sessionId: currentSessionId
      });
    }

    if (response?.error) {
      console.error('[ReplayX BG] Start recording error:', response.error);
      cleanupRecording();
      sendResponse({ success: false, error: response.error });
      return;
    }

    if (response?.success) {
      console.log('[ReplayX BG] Recording started for session:', currentSessionId);
      sendResponse({ success: true, sessionId: currentSessionId });
    } else {
      cleanupRecording();
      sendResponse({ success: false, error: 'Content script failed to start' });
    }
  } catch (error) {
    console.error('[ReplayX BG] Error starting recording:', error);
    cleanupRecording();
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

async function handleStopRecording(sendResponse: (response: any) => void) {
  if (!isRecording || !currentTabId || !currentSessionId) {
    sendResponse({ success: false, error: 'Not recording' });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { action: 'STOP_RECORD' });

    if (response?.success) {
      const sessionState = sessionStates.get(currentSessionId);
      if (sessionState) {
        sessionState.status = 'completed';
        sessionState.events = sessionState.events.concat(response.events || []);

        const mergedEvents = sessionState.events;
        const pageUrls = Array.from(new Set([
          sessionState.url || '',
          ...mergedEvents.filter(e => e.type === 'Navigation').map(e => (e.payload as any).url || '')
        ])).filter(Boolean);
        const endTime = Date.now();

        // Create session data
        const session: SessionData = {
          id: currentSessionId,
          url: sessionState.url || response.url || 'unknown',
          startTime: sessionState.startTime,
          endTime,
          initialState: response.initialState || undefined,
          events: mergedEvents,
          metadata: {
            userAgent: navigator.userAgent,
            viewport: response.viewport || { width: 0, height: 0 },
            totalEvents: mergedEvents.length,
            duration: mergedEvents.length > 0 ? Math.max(...mergedEvents.map((e: RecordedEvent) => e.timestamp)) -
                     Math.min(...mergedEvents.map((e: RecordedEvent) => e.timestamp)) : 0,
            pageUrls,
            cookiesCaptured: response.initialState?.cookies || undefined,
            replayIssues: 0
          }
        };

        await saveSession(session);
        console.log('[ReplayX BG] Session saved:', currentSessionId);
        sendResponse({ success: true, sessionId: currentSessionId });
      } else {
        sendResponse({ success: false, error: 'Session state not found' });
      }
    } else {
      sendResponse({ success: false, error: 'Content script failed to stop' });
    }
  } catch (error) {
    console.error('[ReplayX BG] Error stopping recording:', error);
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  } finally {
    cleanupRecording();
  }
}

function handleSaveRecordingEvents(sessionId: string, events: RecordedEvent[], sendResponse: (response: any) => void) {
  if (!sessionId || !sessionStates.has(sessionId)) {
    sendResponse({ success: false, error: 'Session not found' });
    return;
  }

  const sessionState = sessionStates.get(sessionId)!;
  sessionState.events = sessionState.events.concat(events || []);
  console.log('[ReplayX BG] Flushed events for recording session:', sessionId, 'count:', events.length);
  sendResponse({ success: true });
}

// Replay handlers
async function handleReplaySession(sessionId: string, speed: number, sendResponse: (response: any) => void, startIndex?: number, step?: boolean) {
  if (activeReplaySession) {
    // Force stop existing replay before starting a new one
    await new Promise((resolve) => {
      handleStopReplay(() => resolve(null));
    });
    // Small delay to ensure cleanup
    await new Promise(r => setTimeout(r, 100));
  }

  try {
    const session = await getSession(sessionId);
    if (!session) {
      sendResponse({ success: false, error: 'Session not found' });
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab?.id) {
      sendResponse({ success: false, error: 'No active tab found' });
      return;
    }

    if (!tab.url || !tab.url.startsWith('http')) {
      sendResponse({ success: false, error: 'Cannot replay on this tab type (restricted URL)' });
      return;
    }

    activeReplaySession = session;
    activeReplaySessionId = session.id;
    replayTabId = tab.id;
    replaySpeed = speed;
    isReplayPaused = false;
    replayProgressIndex = 0;
    persistReplayState();

    // Check if we need to navigate
    const currentUrl = new URL(tab.url);
    const sessionUrl = new URL(session.url);

    if (currentUrl.href !== sessionUrl.href) {
      // Navigate to the exact recorded session URL
      await chrome.tabs.update(tab.id, { url: session.url });
      // Replay will start automatically via tabs.onUpdated listener
      sendResponse({ success: true });
    } else {
      // Start replay immediately
      let response = await sendMessageToTab(tab.id, {
        action: 'START_REPLAY',
        session,
        speed,
        resumeIndex: startIndex || 0
      });

      if (response?.error && response.error.includes('Receiving end does not exist')) {
        console.log('[ReplayX BG] Content script missing, injecting...');
        await ensureContentScript(tab.id);
        response = await sendMessageToTab(tab.id, { action: 'START_REPLAY', session, speed });
      }

      if (response?.error) {
        activeReplaySession = null;
        replayTabId = null;
        sendResponse({ success: false, error: response.error });
      } else {
        // If caller requested a single-step start, forward STEP_REPLAY
        if (step) {
          chrome.tabs.sendMessage(tab.id, { action: 'STEP_REPLAY' });
        }
        sendResponse({ success: true });
      }
    }
  } catch (error) {
    console.error('[ReplayX BG] Error starting replay:', error);
    activeReplaySession = null;
    replayTabId = null;
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

function handleStopReplay(sendResponse: (response: any) => void) {
  if (replayTabId) {
    // Clear local state regardless of whether the content script responds
    // to prevent the replayer from getting stuck in a "replaying" state.
    chrome.tabs.sendMessage(replayTabId, { action: 'STOP_REPLAY' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[ReplayX BG] Stop signal sent to inactive tab, clearing state.');
      }
      activeReplaySession = null;
      activeReplaySessionId = null;
      replayTabId = null;
      isReplayPaused = false;
      clearPersistedReplayState();
      sendResponse({ success: true });
    });
  } else {
    activeReplaySession = null;
    activeReplaySessionId = null;
    isReplayPaused = false;
    clearPersistedReplayState();
    sendResponse({ success: true });
  }
}

// Session management
async function handleExportSession(sessionId: string, sendResponse: (response: any) => void) {
  try {
    const session = await getSession(sessionId);
    if (!session) {
      sendResponse({ success: false, error: 'Session not found' });
      return;
    }

    const dataStr = JSON.stringify(session, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });

    // Create download
    const url = URL.createObjectURL(dataBlob);
    await chrome.downloads.download({
      url,
      filename: `replayx-session-${sessionId}.json`,
      saveAs: true
    });

    URL.revokeObjectURL(url);
    sendResponse({ success: true });
  } catch (error) {
    console.error('[ReplayX BG] Error exporting session:', error);
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Export failed' });
  }
}

async function handleImportSession(sessionData: SessionData, sendResponse: (response: any) => void) {
  try {
    // Validate session data
    if (!sessionData.id || !sessionData.events || !Array.isArray(sessionData.events)) {
      sendResponse({ success: false, error: 'Invalid session data' });
      return;
    }

    await saveSession(sessionData);
    sendResponse({ success: true, sessionId: sessionData.id });
  } catch (error) {
    console.error('[ReplayX BG] Error importing session:', error);
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Import failed' });
  }
}

// Utility functions
function cleanupRecording() {
  isRecording = false;
  currentTabId = null;
  currentSessionId = null;
  recordingStartTime = 0;
  isPaused = false;
}

function cleanupTabState(tabId: number) {
  if (currentTabId === tabId) {
    cleanupRecording();
  }
  if (replayTabId === tabId) {
    activeReplaySession = null;
    activeReplaySessionId = null;
    replayTabId = null;
    clearPersistedReplayState();
  }

  // Clean up session states
  for (const [sessionId, state] of sessionStates) {
    if (state.tabId === tabId) {
      sessionStates.delete(sessionId);
    }
  }
}

// Periodic cleanup
setInterval(() => {
  // Clean up old completed sessions from memory
  const now = Date.now();
  for (const [sessionId, state] of sessionStates) {
    if (state.status === 'completed' && now - state.startTime > 3600000) { // 1 hour
      sessionStates.delete(sessionId);
    }
  }
}, 300000); // 5 minutes
