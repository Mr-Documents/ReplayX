/**
 * MV3 service-worker entry point.
 *
 * Deliberately thin: all decision logic lives in `router.ts` so it is testable
 * without a browser. This file only adapts chrome APIs to that interface and
 * owns worker lifecycle concerns (alarms, tab teardown).
 */
import type { BackgroundRequest } from '../messages';
import {
  appendSessionEvents,
  deleteSession,
  getSession,
  getSessionSummaries,
  saveSession,
  scheduleAutoCleanup,
  updateSessionMetadata,
  updateSessionReplayResults,
} from '../storage/db';
import { createRouter, type TabAdapter, type TabInfo } from './router';
import { createStateStore } from './state';

const state = createStateStore();

const tabs: TabAdapter = {
  async queryActive(): Promise<TabInfo | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return { id: tab.id, url: tab.url ?? '' };
  },

  sendMessage(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ delivered: false, error: lastError.message });
            return;
          }
          resolve({ delivered: true, response });
        });
      } catch (error) {
        resolve({ delivered: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  },

  async navigate(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  },

  async injectContentScript(tabId) {
    const path = mainContentScriptPath();
    if (!path) {
      console.warn('[ReplayX BG] Could not resolve the content script path from the manifest');
      return false;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [path] });
      return true;
    } catch (error) {
      console.warn('[ReplayX BG] Content script injection failed:', error);
      return false;
    }
  },
};

/** Resolves the built content-script filename, which the bundler hashes. */
function mainContentScriptPath(): string | null {
  const manifest = chrome.runtime.getManifest();
  const scripts = manifest.content_scripts ?? [];
  for (const entry of scripts) {
    // The MAIN-world entry is the interceptor; the isolated-world one is main.ts.
    if ((entry as { world?: string }).world === 'MAIN') continue;
    const file = entry.js?.[0];
    if (file) return file;
  }
  return null;
}

const router = createRouter({
  db: {
    saveSession,
    appendSessionEvents,
    updateSessionMetadata,
    updateSessionReplayResults,
    getSession,
    getSessionSummaries,
    deleteSession,
  },
  tabs,
  state,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const request = message as BackgroundRequest;
  if (!request || typeof request.action !== 'string') {
    sendResponse({ success: false, error: 'Malformed message' });
    return false;
  }

  router
    .handle(request, sender.tab?.id)
    .then((result) => sendResponse(result))
    .catch((error: unknown) => {
      console.error(`[ReplayX BG] ${request.action} failed:`, error);
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    });

  // Every handler is async, so the channel must stay open unconditionally.
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const current = await state.get();
    const patch: Parameters<typeof state.patch>[0] = {};
    if (current.recording?.tabId === tabId) patch.recording = null;
    if (current.replay?.tabId === tabId) patch.replay = null;
    if (Object.keys(patch).length > 0) await state.patch(patch);
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAutoCleanup();
});

chrome.runtime.onStartup?.addListener(() => {
  scheduleAutoCleanup();
});

// Also register on cold start so the alarm exists after a worker recycle.
scheduleAutoCleanup();

console.info('[ReplayX BG] Service worker ready');
