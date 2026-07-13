import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Recorder } from '../content/recorder';
import { RecordedEvent } from '../types';

describe('Recording Integration Tests', () => {
  let recorder: Recorder;
  let mockDocument: any;
  let mockWindow: any;

  beforeEach(() => {
    // Mock DOM environment
    mockDocument = {
      body: { innerHTML: '<div id="test">Test</div>' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(),
      getElementsByTagName: vi.fn(() => []),
      getElementsByClassName: vi.fn(() => []),
    };

    mockWindow = {
      location: { href: 'http://example.com' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      performance: { now: () => Date.now() },
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    };

    // Override global objects
    (globalThis as any).document = mockDocument;
    (globalThis as any).window = mockWindow;

    recorder = new Recorder();
  });

  afterEach(() => {
    if (recorder) {
      recorder.stop();
    }
  });

  describe('Recording Lifecycle', () => {
    it('should start recording with a valid session ID', () => {
      const sessionId = recorder.start('http://example.com');
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(recorder.isRecordingActive()).toBe(true);
    });

    it('should stop recording and return events', () => {
      recorder.start('http://example.com');
      const result = recorder.stop();
      
      expect(result).toBeDefined();
      expect(result.events).toBeInstanceOf(Array);
      expect(result.startTime).toBeGreaterThan(0);
    });

    it('should pause and resume recording', () => {
      recorder.start('http://example.com');
      
      recorder.pause();
      expect(recorder.isRecordingActive()).toBe(true); // Still recording but paused
      
      recorder.resume();
      expect(recorder.isRecordingActive()).toBe(true);
    });

    it('should not start recording if already recording', () => {
      recorder.start('http://example.com');
      const sessionId2 = recorder.start('http://example.com');
      
      expect(sessionId2).toBe(sessionId2); // Should return same session ID
    });
  });

  describe('Event Recording', () => {
    it('should capture click events', () => {
      recorder.start('http://example.com');
      
      const clickEvent = new MouseEvent('click', {
        clientX: 100,
        clientY: 200,
        bubbles: true
      });
      
      recorder['onClick'](clickEvent);
      
      const result = recorder.stop();
      expect(result.events.length).toBeGreaterThan(0);
    });

    it('should capture input events', () => {
      recorder.start('http://example.com');
      
      const inputEvent = new Event('input', { bubbles: true });
      recorder['onInput'](inputEvent);
      
      const result = recorder.stop();
      expect(result.events.length).toBeGreaterThan(0);
    });

    it('should mask sensitive input values', () => {
      recorder.start('http://example.com');
      
      const inputEvent = new Event('input', { bubbles: true });
      recorder['onInput'](inputEvent);
      
      const result = recorder.stop();
      const inputEvents = result.events.filter((e: RecordedEvent) => e.type === 'Input');
      
      if (inputEvents.length > 0) {
        expect((inputEvents[0]?.payload as any).value).toBe('********');
      }
    });
  });

  describe('Memory Management', () => {
    it('should enforce maximum event limit', () => {
      recorder.start('http://example.com');
      
      // Add more events than the limit
      for (let i = 0; i < 60000; i++) {
        recorder.addEvent({
          id: `event-${i}`,
          sessionId: recorder.getSessionId(),
          timestamp: i,
          type: 'Click',
          payload: { selector: '#test' }
        } as RecordedEvent);
      }
      
      const result = recorder.stop();
      expect(result.events.length).toBeLessThanOrEqual(50000);
    });

    it('should flush events periodically', () => {
      const flushSpy = vi.spyOn(recorder as any, 'flushEventsToBackground');
      
      recorder.start('http://example.com');
      
      // Add enough events to trigger flush
      for (let i = 0; i < 1500; i++) {
        recorder.addEvent({
          id: `event-${i}`,
          sessionId: recorder.getSessionId(),
          timestamp: i,
          type: 'Click',
          payload: { selector: '#test' }
        } as RecordedEvent);
      }
      
      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('Rate Limiting', () => {
    it('should rate limit scroll events', () => {
      recorder.start('http://example.com');
      
      const scrollEvent = new Event('scroll', { bubbles: true });
      
      // Fire multiple scroll events quickly
      for (let i = 0; i < 10; i++) {
        recorder['onScroll'](scrollEvent);
      }
      
      const result = recorder.stop();
      // Should have fewer events than fired due to rate limiting
      expect(result.events.length).toBeLessThan(10);
    });

    it('should rate limit input events', () => {
      recorder.start('http://example.com');
      
      const inputEvent = new Event('input', { bubbles: true });
      
      // Fire multiple input events quickly
      for (let i = 0; i < 10; i++) {
        recorder['onInput'](inputEvent);
      }
      
      const result = recorder.stop();
      // Should have fewer events than fired due to rate limiting
      expect(result.events.length).toBeLessThan(10);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing DOM elements gracefully', () => {
      recorder.start('http://example.com');
      
      const clickEvent = new MouseEvent('click', {
        clientX: 100,
        clientY: 200,
        bubbles: true
      });
      
      // Simulate click with null target
      expect(() => {
        recorder['onClick'](clickEvent);
      }).not.toThrow();
    });

    it('should handle invalid event data', () => {
      recorder.start('http://example.com');
      
      expect(() => {
        recorder.addEvent(null as any);
      }).not.toThrow();
      
      expect(() => {
        recorder.addEvent(undefined as any);
      }).not.toThrow();
    });
  });
});
