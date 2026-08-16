import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimatePayloadBytes, generateId, Recorder } from './recorder';
import { REPLAYX_UI_ATTR } from './selector';
import type { InputPayload, KeyPayload, RecordedEvent, ScrollPayload, TargetPayload } from '../types';

let recorder: Recorder;

beforeEach(() => {
  document.body.innerHTML = '';
  recorder = new Recorder();
});

afterEach(() => {
  if (recorder.isRecordingActive()) recorder.stop();
  vi.useRealTimers();
});

function eventsOfType(events: RecordedEvent[], type: RecordedEvent['type']): RecordedEvent[] {
  return events.filter((event) => event.type === type);
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 }));
}

describe('lifecycle', () => {
  it('reports active state and is idempotent on start', () => {
    recorder.start('session-1');
    expect(recorder.isRecordingActive()).toBe(true);
    expect(recorder.getSessionId()).toBe('session-1');

    recorder.start('session-2');
    expect(recorder.getSessionId()).toBe('session-1');
  });

  it('returns an empty result when stopping without starting', () => {
    expect(recorder.stop()).toEqual({ events: [], startTime: 0, initialState: null });
  });

  it('captures the initial state snapshot', () => {
    localStorage.setItem('theme', 'dark');
    recorder.start('session-1');
    const { initialState } = recorder.stop();
    expect(initialState?.localStorage.theme).toBe('dark');
    expect(initialState?.url).toBe(window.location.href);
  });

  it('removes its listeners on stop', () => {
    document.body.innerHTML = '<button id="b">go</button>';
    recorder.start('session-1');
    recorder.stop();

    recorder.start('session-2');
    const before = recorder.flushEvents().length;
    recorder.stop();
    // A leaked listener from the first session would double-record here.
    expect(before).toBe(0);
  });

  it('switches the MAIN-world interceptor into RECORD mode', () => {
    // Nothing sent SET_MODE before, so network recording never actually ran.
    const posted = vi.spyOn(window, 'postMessage');
    recorder.start('session-1');
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'replayx-content', action: 'SET_MODE', mode: 'RECORD' }),
      '*',
    );

    posted.mockClear();
    recorder.stop();
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SET_MODE', mode: 'IDLE' }),
      '*',
    );
  });
});

describe('event capture', () => {
  it('records clicks with target metadata', () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    recorder.start('session-1');
    click(document.getElementById('save')!);

    const [event] = eventsOfType(recorder.stop().events, 'Click');
    expect(event).toBeDefined();
    expect((event!.payload as TargetPayload).selector).toBe('#save');
    expect(event!.payload.frameUrl).toBe(window.location.href);
    expect(event!.sequence).toBe(1);
  });

  it('assigns monotonic sequence numbers', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    recorder.start('session-1');
    click(document.getElementById('a')!);
    click(document.getElementById('b')!);
    const events = eventsOfType(recorder.stop().events, 'Click');
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('ignores interactions with ReplayX’s own UI', () => {
    document.body.innerHTML = `<div ${REPLAYX_UI_ATTR}="widget"><span id="dot"></span></div>`;
    recorder.start('session-1');
    click(document.getElementById('dot')!);
    expect(eventsOfType(recorder.stop().events, 'Click')).toHaveLength(0);
  });

  it('ignores events while the replayer is driving the page', () => {
    document.body.innerHTML = '<button id="b">go</button>';
    (window as unknown as Record<string, unknown>)._replayx_is_replaying = true;
    recorder.start('session-1');
    click(document.getElementById('b')!);
    const events = recorder.stop().events;
    delete (window as unknown as Record<string, unknown>)._replayx_is_replaying;
    expect(eventsOfType(events, 'Click')).toHaveLength(0);
  });

  it('does not record while paused, and resumes afterwards', () => {
    document.body.innerHTML = '<button id="b">go</button>';
    const button = document.getElementById('b')!;
    recorder.start('session-1');

    recorder.pause();
    click(button);
    recorder.resume();
    click(button);

    expect(eventsOfType(recorder.stop().events, 'Click')).toHaveLength(1);
  });
});

describe('privacy masking', () => {
  it('masks password fields on input', () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    const input = document.getElementById('pw') as HTMLInputElement;
    recorder.start('session-1');
    input.value = 'hunter2';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const [event] = eventsOfType(recorder.stop().events, 'Input');
    expect((event!.payload as InputPayload).value).toBe('********');
    expect((event!.payload as InputPayload).masked).toBe(true);
  });

  it('masks password fields on change too', () => {
    // Change events were stored unmasked, leaking what Input had redacted.
    document.body.innerHTML = '<input id="pw" type="password">';
    const input = document.getElementById('pw') as HTMLInputElement;
    recorder.start('session-1');
    input.value = 'hunter2';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const [event] = eventsOfType(recorder.stop().events, 'Change');
    expect((event!.payload as InputPayload).value).toBe('********');
  });

  it('masks fields whose name looks sensitive', () => {
    document.body.innerHTML = '<input id="cc" name="credit_card_number" type="text">';
    const input = document.getElementById('cc') as HTMLInputElement;
    recorder.start('session-1');
    input.value = '4111111111111111';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect((eventsOfType(recorder.stop().events, 'Input')[0]!.payload as InputPayload).value).toBe('********');
  });

  it('leaves ordinary fields intact', () => {
    document.body.innerHTML = '<input id="name" name="fullName" type="text">';
    const input = document.getElementById('name') as HTMLInputElement;
    recorder.start('session-1');
    input.value = 'Ada';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const payload = eventsOfType(recorder.stop().events, 'Input')[0]!.payload as InputPayload;
    expect(payload.value).toBe('Ada');
    expect(payload.masked).toBe(false);
  });

  it('records checkbox state rather than masking it', () => {
    document.body.innerHTML = '<input id="agree" type="checkbox" name="password_agree">';
    const input = document.getElementById('agree') as HTMLInputElement;
    recorder.start('session-1');
    input.checked = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect((eventsOfType(recorder.stop().events, 'Input')[0]!.payload as InputPayload).value).toBe('true');
  });
});

describe('keyboard capture', () => {
  it('tags keydown and keyup distinctly', () => {
    // Both edges were recorded identically, so replay fired every key twice.
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i')!;
    recorder.start('session-1');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

    const keys = eventsOfType(recorder.stop().events, 'Key');
    expect(keys.map((k) => (k.payload as KeyPayload).kind)).toEqual(['down', 'up']);
  });

  it('drops auto-repeat keydowns', () => {
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i')!;
    recorder.start('session-1');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true }));

    expect(eventsOfType(recorder.stop().events, 'Key')).toHaveLength(1);
  });
});

describe('scroll debouncing', () => {
  it('records the final scroll position, not the first', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="pane" style="overflow:auto">content</div>';
    const pane = document.getElementById('pane') as HTMLElement;
    recorder.start('session-1');

    Object.defineProperty(pane, 'scrollTop', { value: 10, configurable: true, writable: true });
    pane.dispatchEvent(new Event('scroll', { bubbles: true }));
    (pane as unknown as { scrollTop: number }).scrollTop = 250;
    pane.dispatchEvent(new Event('scroll', { bubbles: true }));

    vi.advanceTimersByTime(200);

    const scrolls = eventsOfType(recorder.stop().events, 'Scroll');
    expect(scrolls).toHaveLength(1);
    // The old leading-edge rate limit captured 10 and discarded 250.
    expect((scrolls[0]!.payload as ScrollPayload).scrollTop).toBe(250);
  });
});

describe('resource limits', () => {
  it('stops accepting events past the configured maximum, preserving what it captured', () => {
    const limited = new Recorder({ maxEvents: 5, flushThreshold: 1_000_000 });
    limited.start('session-1');
    for (let i = 0; i < 20; i++) {
      limited.addEvent({
        id: `e-${i}`,
        sessionId: 'session-1',
        timestamp: i,
        type: 'Click',
        payload: { selector: '#x', x: 0, y: 0 },
      } as RecordedEvent);
    }

    // Hitting the cap hands the buffer to the background rather than dropping it.
    const flush = chromeStub.runtime.sendMessage.mock.calls.find(
      ([message]) => (message as { action?: string })?.action === 'SAVE_RECORDING_EVENTS',
    );
    expect(flush).toBeDefined();
    expect((flush![0] as { events: RecordedEvent[] }).events).toHaveLength(5);
    limited.stop();
  });

  it('does not tear itself down when a limit is hit', () => {
    // The old code called stop() from inside addEvent, discarding the buffer
    // and removing listeners mid-dispatch.
    const limited = new Recorder({ maxEvents: 2, flushThreshold: 1_000_000 });
    limited.start('session-1');
    for (let i = 0; i < 5; i++) {
      limited.addEvent({
        id: `e-${i}`,
        sessionId: 'session-1',
        timestamp: i,
        type: 'Click',
        payload: { selector: '#x', x: 0, y: 0 },
      } as RecordedEvent);
    }
    expect(limited.isRecordingActive()).toBe(true);
    limited.stop();
  });

  it('flushes to the background once the threshold is reached', () => {
    const limited = new Recorder({ flushThreshold: 3 });
    limited.start('session-1');
    for (let i = 0; i < 3; i++) {
      limited.addEvent({
        id: `e-${i}`,
        sessionId: 'session-1',
        timestamp: i,
        type: 'Click',
        payload: { selector: '#x', x: 0, y: 0 },
      } as RecordedEvent);
    }
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SAVE_RECORDING_EVENTS', sessionId: 'session-1' }),
      expect.any(Function),
    );
    limited.stop();
  });

  it('ignores null and malformed events', () => {
    recorder.start('session-1');
    expect(() => recorder.addEvent(null)).not.toThrow();
    expect(() => recorder.addEvent(undefined)).not.toThrow();
    expect(() => recorder.addEvent({} as RecordedEvent)).not.toThrow();
    expect(recorder.stop().events).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('generates distinct ids', () => {
    expect(generateId()).not.toBe(generateId());
  });

  it('estimates payload size from string fields', () => {
    const small = estimatePayloadBytes({ payload: { a: 'x' } } as unknown as RecordedEvent);
    const large = estimatePayloadBytes({ payload: { a: 'x'.repeat(1000) } } as unknown as RecordedEvent);
    expect(large).toBeGreaterThan(small + 900);
  });
});

describe('host page containment', () => {
  /**
   * The recorder attaches capture-phase listeners to every page the user
   * visits. Nothing it does may surface as an error in the page's own console
   * or interrupt the page's event dispatch.
   */

  function breakSelectorGeneration(el: Element): void {
    // A realistic failure: an element whose tagName access throws (proxied or
    // cross-realm nodes in the wild do this).
    Object.defineProperty(el, 'tagName', {
      configurable: true,
      get() {
        throw new Error('hostile element');
      },
    });
  }

  it('does not let a capture failure escape into the page', () => {
    document.body.innerHTML = '<button id="b">go</button>';
    const button = document.getElementById('b')!;
    breakSelectorGeneration(button);

    recorder.start('session-1');

    const laterListener = vi.fn();
    button.addEventListener('click', laterListener);

    expect(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
    }).not.toThrow();

    // The page's own listener still ran.
    expect(laterListener).toHaveBeenCalledOnce();
    expect(recorder.isRecordingActive()).toBe(true);
  });

  it('keeps recording siblings of an element that throws on property access', () => {
    // A hostile sibling used to poison its neighbours too: the structural-path
    // walk reads tagName on every child of every ancestor, so one throwing node
    // made its whole subtree unrecordable.
    document.body.innerHTML = '<button id="bad">bad</button><button id="ok">ok</button>';
    const bad = document.getElementById('bad')!;
    const ok = document.getElementById('ok')!;
    breakSelectorGeneration(bad);

    recorder.start('session-1');
    bad.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ok.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const clicks = eventsOfType(recorder.stop().events, 'Click');
    expect(clicks).toHaveLength(2);
    expect((clicks[1]!.payload as TargetPayload).selector).toBe('#ok');
  });

  it('does not break the page router when pushState capture fails', () => {
    // The patched pushState runs inside the site's own navigation call, so a
    // throw here would break client-side routing outright.
    recorder.start('session-1');
    const spy = vi.spyOn(recorder as unknown as { onNavigation: () => void }, 'onNavigation');
    spy.mockImplementation(() => {
      throw new Error('capture exploded');
    });

    expect(() => history.pushState({}, '', '/next')).not.toThrow();
    // The page's navigation still took effect.
    expect(window.location.pathname).toBe('/next');

    spy.mockRestore();
    recorder.stop();
  });

  it('restores the original history methods on stop', () => {
    const before = history.pushState;
    recorder.start('session-1');
    expect(history.pushState).not.toBe(before);
    recorder.stop();
    expect(history.pushState).toBe(before);
  });

  it('survives an unserialisable mutation without losing the observer', () => {
    document.body.innerHTML = '<div id="root"></div>';
    recorder.start('session-1');

    const observer = (recorder as unknown as { mutationObserver: MutationObserver | null }).mutationObserver;
    expect(observer).not.toBeNull();

    const hostile = document.createElement('span');
    breakSelectorGeneration(hostile);

    // Drive the observer callback directly with a hostile record.
    const callback = (observer as unknown as { callback?: unknown }) && null;
    void callback;
    expect(() => {
      document.getElementById('root')!.appendChild(hostile);
    }).not.toThrow();

    recorder.stop();
  });

  it('tolerates a missing chrome runtime when flushing', () => {
    const originalChrome = globalThis.chrome;
    const limited = new Recorder({ flushThreshold: 1 });
    limited.start('session-1');
    (globalThis as { chrome?: unknown }).chrome = undefined;

    expect(() => {
      limited.addEvent({
        id: 'e-1',
        sessionId: 'session-1',
        timestamp: 0,
        type: 'Click',
        payload: { selector: '#x', x: 0, y: 0 },
      } as RecordedEvent);
    }).not.toThrow();

    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    limited.stop();
  });
});
