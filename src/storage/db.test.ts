import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  saveSession, 
  getSession, 
  getSessions, 
  deleteSession, 
  cleanupOldSessions,
  scheduleAutoCleanup 
} from './db';
import { SessionData, RecordedEvent } from '../types';

describe('Storage Layer Tests', () => {
  beforeEach(() => {
    // Clear IndexedDB before each test
    indexedDB = new IDBFactory() as any;
  });

  afterEach(async () => {
    // Clean up after each test
    const sessions = await getSessions();
    for (const session of sessions) {
      await deleteSession(session.id);
    }
  });

  describe('Session CRUD Operations', () => {
    it('should save a session successfully', async () => {
      const session: SessionData = {
        id: 'test-session-1',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      await saveSession(session);
      
      const retrieved = await getSession('test-session-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('test-session-1');
      expect(retrieved?.url).toBe('http://example.com');
    });

    it('should retrieve a session by ID', async () => {
      const session: SessionData = {
        id: 'test-session-2',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      await saveSession(session);
      const retrieved = await getSession('test-session-2');
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('test-session-2');
    });

    it('should return null for non-existent session', async () => {
      const retrieved = await getSession('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should get all sessions', async () => {
      const session1: SessionData = {
        id: 'test-session-3',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      const session2: SessionData = {
        id: 'test-session-4',
        url: 'http://example.org',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.org']
        }
      };

      await saveSession(session1);
      await saveSession(session2);
      
      const allSessions = await getSessions();
      expect(allSessions.length).toBeGreaterThanOrEqual(2);
    });

    it('should delete a session', async () => {
      const session: SessionData = {
        id: 'test-session-5',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      await saveSession(session);
      await deleteSession('test-session-5');
      
      const retrieved = await getSession('test-session-5');
      expect(retrieved).toBeNull();
    });
  });

  describe('Event Storage', () => {
    it('should save sessions with events', async () => {
      const events: RecordedEvent[] = [
        {
          id: 'event-1',
          sessionId: 'test-session-6',
          timestamp: 0,
          type: 'Click',
          payload: { selector: '#button', x: 100, y: 200 }
        } as any,
        {
          id: 'event-2',
          sessionId: 'test-session-6',
          timestamp: 100,
          type: 'Input',
          payload: { selector: '#input', value: 'test', inputType: 'text' }
        } as any
      ];

      const session: SessionData = {
        id: 'test-session-6',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events,
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 2,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      await saveSession(session);
      const retrieved = await getSession('test-session-6');
      
      expect(retrieved?.events?.length).toBe(2);
      expect(retrieved?.events?.[0]?.type).toBe('Click');
      expect(retrieved?.events?.[1]?.type).toBe('Input');
    });

    it('should handle large numbers of events', async () => {
      const events: RecordedEvent[] = [];
      for (let i = 0; i < 1000; i++) {
        events.push({
          id: `event-${i}`,
          sessionId: 'test-session-7',
          timestamp: i,
          type: 'Click',
          payload: { selector: `#element-${i}`, x: 100, y: 200 }
        } as any);
      }

      const session: SessionData = {
        id: 'test-session-7',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events,
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 1000,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      await saveSession(session);
      const retrieved = await getSession('test-session-7');
      
      expect(retrieved?.events.length).toBe(1000);
    });
  });

  describe('Data Retention', () => {
    it('should clean up old sessions', async () => {
      const oldSession: SessionData = {
        id: 'old-session',
        url: 'http://example.com',
        startTime: Date.now() - (40 * 24 * 60 * 60 * 1000), // 40 days ago
        endTime: Date.now() - (40 * 24 * 60 * 60 * 1000) + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      const recentSession: SessionData = {
        id: 'recent-session',
        url: 'http://example.com',
        startTime: Date.now() - (10 * 24 * 60 * 60 * 1000), // 10 days ago
        endTime: Date.now() - (10 * 24 * 60 * 60 * 1000) + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      await saveSession(oldSession);
      await saveSession(recentSession);
      
      await cleanupOldSessions();
      
      const oldRetrieved = await getSession('old-session');
      const recentRetrieved = await getSession('recent-session');
      
      expect(oldRetrieved).toBeNull();
      expect(recentRetrieved).toBeDefined();
    });

    it('should enforce maximum session count', async () => {
      // Create more sessions than the limit
      const sessions: SessionData[] = [];
      for (let i = 0; i < 150; i++) {
        const session: SessionData = {
          id: `session-${i}`,
          url: 'http://example.com',
          startTime: Date.now() - (i * 1000),
          endTime: Date.now() - (i * 1000) + 1000,
          events: [],
          metadata: {
            userAgent: 'test-agent',
            viewport: { width: 1920, height: 1080 },
            totalEvents: 0,
            duration: 1000,
            pageUrls: ['http://example.com']
          }
        };
        sessions.push(session);
        await saveSession(session);
      }
      
      await cleanupOldSessions();
      
      const allSessions = await getSessions();
      expect(allSessions.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Auto Cleanup', () => {
    it('should schedule auto cleanup', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      
      scheduleAutoCleanup();
      
      expect(setIntervalSpy).toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('should handle auto cleanup errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Mock cleanup to fail
      vi.spyOn(globalThis as any, 'cleanupOldSessions').mockRejectedValue(new Error('Test error'));
      
      scheduleAutoCleanup();
      
      // Wait for interval to trigger
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid session data', async () => {
      const invalidSession = null as any;
      
      await expect(saveSession(invalidSession)).rejects.toThrow();
    });

    it('should handle missing session ID on delete', async () => {
      await expect(deleteSession('')).rejects.toThrow();
    });

    it('should handle concurrent operations', async () => {
      const session: SessionData = {
        id: 'concurrent-session',
        url: 'http://example.com',
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        events: [],
        metadata: {
          userAgent: 'test-agent',
          viewport: { width: 1920, height: 1080 },
          totalEvents: 0,
          duration: 1000,
          pageUrls: ['http://example.com']
        }
      };

      // Perform multiple operations concurrently
      const operations = [
        saveSession(session),
        getSession('concurrent-session'),
        getSessions()
      ];

      await expect(Promise.all(operations)).resolves.toBeDefined();
    });
  });
});
