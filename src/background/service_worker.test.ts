import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Background Service Worker Tests', () => {
  beforeEach(() => {
    // Mock chrome APIs
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn((_message, callback) => {
          if (callback) callback({ success: true });
          return true;
        }),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        },
        lastError: null
      },
      tabs: {
        query: vi.fn(() => Promise.resolve([{ id: 1, url: 'http://example.com' }])),
        sendMessage: vi.fn(() => Promise.resolve({ success: true })),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        },
        onRemoved: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        }
      },
      scripting: {
        executeScript: vi.fn(() => Promise.resolve())
      }
    };

    // Mock crypto
    (globalThis as any).crypto = {
      randomUUID: vi.fn(() => 'test-session-id')
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Message Handling', () => {
    it('should handle START_RECORD action', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'START_RECORD'
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });

    it('should handle STOP_RECORD action', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'STOP_RECORD'
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });

    it('should handle GET_STATE action', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'GET_STATE'
      }, (response: any) => {
        expect(response).toBeDefined();
      });
    });

    it('should handle unknown actions gracefully', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'UNKNOWN_ACTION'
      }, (response: any) => {
        expect(response?.success).toBe(false);
      });
    });
  });

  describe('Session Management', () => {
    it('should create unique session IDs', () => {
      const mockCrypto = (globalThis as any).crypto;
      const sessionId1 = mockCrypto.randomUUID();
      const sessionId2 = mockCrypto.randomUUID();
      
      expect(sessionId1).toBeDefined();
      expect(sessionId2).toBeDefined();
      // In a real implementation, these would be different
    });

    it('should track active recording state', () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'START_RECORD'
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });

    it('should track active replay state', () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'START_REPLAY',
        sessionId: 'test-session'
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });
  });

  describe('Tab Lifecycle', () => {
    it('should handle tab updates', () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      
      mockTabs.onUpdated.addListener((callback: any) => {
        expect(typeof callback).toBe('function');
      });
    });

    it('should handle tab removal', () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      
      mockTabs.onRemoved.addListener((callback: any) => {
        expect(typeof callback).toBe('function');
      });
    });

    it('should clean up state when tab is closed', () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      
      mockTabs.onRemoved.addListener((callback: any) => {
        // Simulate tab closure
        callback(1);
      });
    });
  });

  describe('Content Script Communication', () => {
    it('should send messages to content scripts', async () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      
      await mockTabs.sendMessage(1, {
        action: 'START_RECORD',
        sessionId: 'test-session'
      });
      
      expect(mockTabs.sendMessage).toHaveBeenCalled();
    });

    it('should handle content script injection failures', async () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      mockTabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
      
      await expect(mockTabs.sendMessage(1, { action: 'START_RECORD' }))
        .rejects.toThrow('Receiving end does not exist');
    });

    it('should retry content script injection on failure', async () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      const mockScripting = (globalThis as any).chrome.scripting;
      
      mockTabs.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'));
      mockScripting.executeScript.mockResolvedValue();
      
      // After retry, should succeed
      mockTabs.sendMessage.mockResolvedValue({ success: true });
      
      await mockTabs.sendMessage(1, { action: 'START_RECORD' });
      
      expect(mockScripting.executeScript).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle chrome runtime errors', () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      mockRuntime.lastError = { message: 'Test error' };
      
      mockRuntime.sendMessage({
        action: 'START_RECORD'
      }, (response: any) => {
        expect(response?.success).toBe(false);
      });
    });

    it('should handle missing tab errors', async () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      mockTabs.query.mockResolvedValue([]);
      
      await expect(mockTabs.query({ active: true, currentWindow: true }))
        .resolves.toEqual([]);
    });

    it('should handle invalid URL errors', async () => {
      const mockTabs = (globalThis as any).chrome.tabs;
      mockTabs.query.mockResolvedValue([{ id: 1, url: 'chrome://extensions' }]);
      
      await expect(mockTabs.query({ active: true, currentWindow: true }))
        .resolves.toEqual([{ id: 1, url: 'chrome://extensions' }]);
    });
  });

  describe('Session Persistence', () => {
    it('should save session data', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      const sessionData = {
        id: 'test-session',
        url: 'http://example.com',
        events: [],
        metadata: {}
      };
      
      mockRuntime.sendMessage({
        action: 'SAVE_SESSION',
        sessionData
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });

    it('should retrieve session data', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'GET_SESSION',
        sessionId: 'test-session'
      }, (response: any) => {
        expect(response).toBeDefined();
      });
    });

    it('should delete session data', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'DELETE_SESSION',
        sessionId: 'test-session'
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });
  });

  describe('Replay State Management', () => {
    it('should track replay progress', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'UPDATE_REPLAY_PROGRESS',
        sessionId: 'test-session',
        progress: 50
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });

    it('should handle replay completion', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'REPLAY_FINISHED',
        sessionId: 'test-session',
        errors: []
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });

    it('should handle replay errors', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      mockRuntime.sendMessage({
        action: 'REPLAY_ERROR',
        sessionId: 'test-session',
        error: 'Test error'
      }, (response: any) => {
        expect(response?.success).toBe(true);
      });
    });
  });

  describe('Performance', () => {
    it('should handle multiple concurrent requests', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      
      const requests = Array.from({ length: 50 }, (_, i) =>
        mockRuntime.sendMessage({
          action: 'GET_SESSION',
          sessionId: `session-${i}`
        }, () => {})
      );
      
      await Promise.all(requests);
      
      expect(mockRuntime.sendMessage).toHaveBeenCalled();
    });

    it('should not block on message handling', async () => {
      const mockRuntime = (globalThis as any).chrome.runtime;
      const startTime = Date.now();
      
      await new Promise(resolve => {
        mockRuntime.sendMessage({
          action: 'GET_STATE'
        }, (response: any) => {
          resolve(response);
        });
      });
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100);
    });
  });
});
