/** @vitest-environment jsdom */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Replayer } from './replayer';
import type { RecordedEvent } from '../types';

describe('Replayer', () => {
  let replayer: Replayer;

  beforeEach(() => {
    replayer = new Replayer();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes event timestamps when scheduling events', () => {
    const events: RecordedEvent[] = [
      {
        id: '1',
        sessionId: 'session-1',
        type: 'Click',
        timestamp: 1000,
        payload: { selector: '#btn1', x: 10, y: 10, targetTag: 'button' }
      },
      {
        id: '2',
        sessionId: 'session-1',
        type: 'Input',
        timestamp: 1500,
        payload: { selector: '#input1', value: 'hello', inputType: 'insertText' }
      },
      {
        id: '3',
        sessionId: 'session-1',
        type: 'Scroll',
        timestamp: 1200,
        payload: { selector: 'window', scrollTop: 50, scrollLeft: 0 }
      }
    ];

    (replayer as any).scheduleEvents(events);

    const queue = (replayer as any).eventQueue as Array<{ scheduledTime: number }>;
    expect(queue.map(item => item.scheduledTime)).toEqual([0, 200, 500]);
    expect((replayer as any).nextEventIndex).toBe(0);
  });

  it('scales delayMs by replay speed', async () => {
    vi.useFakeTimers();
    replayer.setSpeed(2);

    const callback = vi.fn();
    const promise = (replayer as any).delayMs(100).then(callback);

    vi.advanceTimersByTime(49);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();

    await promise;
  });

  it('uses history.back for back navigation during replay', async () => {
    const backSpy = vi.fn();
    Object.defineProperty(window.history, 'back', {
      configurable: true,
      value: backSpy
    });

    const event: RecordedEvent = {
      id: 'nav-1',
      sessionId: 'session-1',
      type: 'Navigation',
      timestamp: 0,
      payload: { url: 'https://example.com/previous', navigationType: 'back' }
    };

    await (replayer as any).executeNavigation(event);

    expect(backSpy).toHaveBeenCalledOnce();
  });

  it('dispatches a click event on the target element during replay', async () => {
    document.body.innerHTML = `<button id="btn">Replay</button>`;
    const button = document.getElementById('btn');
    const clickSpy = vi.fn();
    button?.addEventListener('click', clickSpy);
    (button as any).scrollIntoView = vi.fn();
    (button as any).getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 20,
      bottom: 20,
      right: 100
    });

    const event: RecordedEvent = {
      id: 'click-1',
      sessionId: 'session-1',
      type: 'Click',
      timestamp: 0,
      payload: { selector: '#btn', x: 0, y: 0, targetTag: 'button' }
    };

    vi.useRealTimers();
    const result = (replayer as any).executeClick(event);
    await result;

    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('captures richer context for replay failures', async () => {
    document.body.innerHTML = '<div></div>';

    const event: RecordedEvent = {
      id: 'click-missing',
      sessionId: 'session-1',
      type: 'Click',
      timestamp: 0,
      payload: { selector: '#missing-button', x: 0, y: 0, targetTag: 'button' }
    };

    await (replayer as any).executeClick(event);

    const errors = (replayer as any).replayErrors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'target_not_found',
      message: 'Click target was not found',
      stage: 'find',
      selector: '#missing-button',
      retryable: true
    });
    expect(errors[0].details).toContain('selector');
  });

  it('detects a replay mismatch when the DOM stays unchanged after an interaction', () => {
    const before = '<button id="btn">Open</button>';
    const after = '<button id="btn">Open</button>';

    const mismatch = (replayer as any).detectDomMismatch(before, after, { eventType: 'Click' });

    expect(mismatch).toMatchObject({
      hasMismatch: true,
      code: 'dom_mismatch'
    });
  });
});
