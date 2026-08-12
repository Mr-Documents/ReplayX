import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCandidates,
  clampSpeed,
  collectNetworkMocks,
  fingerprintsDiffer,
  normalizeUrl,
  Replayer,
} from './replayer';
import { REPLAYX_UI_ATTR } from './selector';
import type { RecordedEvent, ReplayErrorEntry } from '../types';

let replayer: Replayer;

function internals(): Record<string, any> {
  return replayer as unknown as Record<string, any>;
}

function makeEvent(overrides: Partial<RecordedEvent> & Pick<RecordedEvent, 'type'>): RecordedEvent {
  return {
    id: overrides.id ?? 'e-1',
    sessionId: 'session-1',
    timestamp: overrides.timestamp ?? 0,
    payload: overrides.payload ?? {},
    ...overrides,
  } as RecordedEvent;
}

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
  replayer = new Replayer();
});

afterEach(() => {
  vi.useRealTimers();
  if (replayer.isActive()) replayer.stop(false);
});

describe('pure helpers', () => {
  it('normalises urls consistently', () => {
    expect(normalizeUrl('https://Example.com/App/#section')).toBe('https://example.com/app');
    expect(normalizeUrl('https://example.com/app/')).toBe('https://example.com/app');
    expect(normalizeUrl('')).toBe('');
  });

  it('clamps replay speed', () => {
    expect(clampSpeed(0.01)).toBe(0.1);
    expect(clampSpeed(50)).toBe(10);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  it('builds candidate selectors in priority order without duplicates', () => {
    const candidates = buildCandidates({
      selector: '#a',
      fallbackSelectors: ['#a', '.b'],
      dataTestId: 'x',
      name: 'n',
      id: 'a',
      targetTag: 'input',
    });
    expect(candidates[0]).toBe('#a');
    expect(candidates.filter((c) => c === '#a')).toHaveLength(1);
    expect(candidates).toContain('[data-testid="x"]');
    expect(candidates).toContain('input[name="n"]');
  });

  it('collects only network events as mocks', () => {
    const mocks = collectNetworkMocks([
      makeEvent({ type: 'Click', id: 'c1' }),
      makeEvent({
        type: 'Network',
        id: 'n1',
        payload: {
          method: 'GET',
          url: 'https://a.test/x',
          requestHeaders: {},
          responseStatus: 200,
          responseHeaders: {},
          responseBody: '{}',
        },
      }),
    ]);
    expect(mocks).toHaveLength(1);
    expect(mocks[0]).toMatchObject({ id: 'n1', method: 'GET', url: 'https://a.test/x' });
  });

  it('compares DOM fingerprints structurally', () => {
    const base = { elements: 5, textLength: 10, structure: 123 };
    expect(fingerprintsDiffer(base, base)).toBe(false);
    expect(fingerprintsDiffer(base, { ...base, elements: 6 })).toBe(true);
    expect(fingerprintsDiffer(base, { ...base, textLength: 11 })).toBe(true);
    expect(fingerprintsDiffer(base, { ...base, structure: 999 })).toBe(true);
  });
});

describe('scheduleEvents', () => {
  it('normalises timestamps relative to the first scheduled event', () => {
    const events = [
      makeEvent({ id: '1', type: 'Click', timestamp: 1000 }),
      makeEvent({ id: '2', type: 'Input', timestamp: 1500 }),
      makeEvent({ id: '3', type: 'Scroll', timestamp: 1200 }),
    ];
    internals().scheduleEvents(events);
    expect(internals().eventQueue.map((i: { scheduledTime: number }) => i.scheduledTime)).toEqual([0, 200, 500]);
    expect(internals().nextEventIndex).toBe(0);
  });

  it('keeps recording order for events sharing a timestamp', () => {
    // A bare sort by time reorders input/submit pairs recorded in the same ms.
    const events = [
      makeEvent({ id: 'input', type: 'Input', timestamp: 500 }),
      makeEvent({ id: 'submit', type: 'Submit', timestamp: 500 }),
    ];
    internals().scheduleEvents(events);
    expect(internals().eventQueue.map((i: { event: RecordedEvent }) => i.event.id)).toEqual(['input', 'submit']);
  });

  it('lets an explicit resume index win over the page checkpoint', () => {
    // The stored checkpoint used to take priority, so "replay from event N"
    // silently restarted from wherever the page had last got to.
    sessionStorage.setItem('replayx_event_index', '1');
    const events = [
      makeEvent({ id: 'a', type: 'Click', timestamp: 0 }),
      makeEvent({ id: 'b', type: 'Click', timestamp: 10 }),
      makeEvent({ id: 'c', type: 'Click', timestamp: 20 }),
    ];
    internals().scheduleEvents(events, 2);
    expect(internals().startIndex).toBe(2);
    expect(internals().eventQueue).toHaveLength(1);
  });

  it('falls back to the stored checkpoint when no index is supplied', () => {
    sessionStorage.setItem('replayx_event_index', '2');
    const events = Array.from({ length: 4 }, (_, i) => makeEvent({ id: `e${i}`, type: 'Click', timestamp: i }));
    internals().scheduleEvents(events);
    expect(internals().startIndex).toBe(2);
  });

  it('clamps an out-of-range resume index', () => {
    const events = [makeEvent({ id: 'a', type: 'Click', timestamp: 0 })];
    internals().scheduleEvents(events, 99);
    expect(internals().startIndex).toBe(1);
    expect(internals().eventQueue).toHaveLength(0);
  });
});

describe('delayMs', () => {
  it('scales with replay speed', async () => {
    vi.useFakeTimers();
    replayer.setSpeed(2);
    const callback = vi.fn();
    const promise = internals().delayMs(100).then(callback);

    vi.advanceTimersByTime(49);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    await promise;
  });
});

describe('event execution', () => {
  it('dispatches a click on the recorded target', async () => {
    document.body.innerHTML = '<button id="btn">Replay</button>';
    const button = document.getElementById('btn')!;
    button.scrollIntoView = vi.fn();
    button.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 20, bottom: 20, right: 100 }) as DOMRect;

    const clickSpy = vi.fn();
    button.addEventListener('click', clickSpy);

    await internals().executeClick(
      makeEvent({ id: 'c', type: 'Click', payload: { selector: '#btn', x: 5, y: 5, targetTag: 'button' } }),
    );

    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('records rich context when a click target cannot be resolved', async () => {
    document.body.innerHTML = '<div></div>';
    await internals().findElement({ selector: '#missing' }, 10);
    await internals().executeClick(
      makeEvent({
        id: 'c',
        type: 'Click',
        payload: { selector: '#missing-button', x: 0, y: 0, targetTag: 'button' },
      }),
    );

    const errors: ReplayErrorEntry[] = replayer.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'target_not_found',
      stage: 'find',
      selector: '#missing-button',
      retryable: true,
      severity: 'error',
    });
  });

  it('fires only the recorded edge of a key event', async () => {
    // Legacy sessions have no `kind` and still fire both edges.
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i') as HTMLInputElement;
    input.focus();

    const down = vi.fn();
    const up = vi.fn();
    input.addEventListener('keydown', down);
    input.addEventListener('keyup', up);

    await internals().executeKey(makeEvent({ type: 'Key', payload: { kind: 'down', key: 'a' } }));
    expect(down).toHaveBeenCalledOnce();
    expect(up).not.toHaveBeenCalled();

    await internals().executeKey(makeEvent({ type: 'Key', payload: { kind: 'up', key: 'a' } }));
    expect(up).toHaveBeenCalledOnce();
  });

  it('still fires both edges for a legacy key event with no kind', async () => {
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i') as HTMLInputElement;
    input.focus();
    const down = vi.fn();
    const up = vi.fn();
    input.addEventListener('keydown', down);
    input.addEventListener('keyup', up);

    await internals().executeKey(makeEvent({ type: 'Key', payload: { key: 'a' } as never }));
    expect(down).toHaveBeenCalledOnce();
    expect(up).toHaveBeenCalledOnce();
  });

  it('uses history.back for back navigation and reports that it navigated', async () => {
    const backSpy = vi.fn();
    Object.defineProperty(window.history, 'back', { configurable: true, value: backSpy });

    const navigated = await internals().executeNavigation(
      makeEvent({ type: 'Navigation', payload: { url: 'https://example.com/prev', navigationType: 'back' } }),
    );

    expect(backSpy).toHaveBeenCalledOnce();
    expect(navigated).toBe(true);
  });

  it('does not navigate when only the hash differs', async () => {
    // The old inline comparison kept the hash and re-navigated on every anchor.
    const navigated = await internals().executeNavigation(
      makeEvent({
        type: 'Navigation',
        payload: { url: `${window.location.href}#section`, navigationType: 'navigate' },
      }),
    );
    expect(navigated).toBe(false);
  });

  it('scrolls the window for a window-scoped scroll event', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
    await internals().executeScroll(
      makeEvent({ type: 'Scroll', payload: { selector: 'window', scrollTop: 120, scrollLeft: 5 } }),
    );
    expect(scrollTo).toHaveBeenCalledWith(5, 120);
  });

  it('treats mutation, resize and network events as non-actionable', async () => {
    for (const type of ['Mutation', 'Resize', 'Network'] as const) {
      await expect(internals().executeEvent(makeEvent({ type }))).resolves.toBe(false);
    }
    expect(replayer.getErrors()).toHaveLength(0);
  });
});

describe('DOM fingerprint', () => {
  it('counts page elements', () => {
    document.body.innerHTML = '<div><span>a</span><span>b</span></div>';
    expect(replayer.fingerprint().elements).toBe(3);
  });

  it('excludes ReplayX’s own UI', () => {
    // Counting our cursor would make the DOM look permanently unstable.
    document.body.innerHTML = '<div><span>a</span></div>';
    const before = replayer.fingerprint();

    const cursor = document.createElement('div');
    cursor.setAttribute(REPLAYX_UI_ATTR, 'cursor');
    document.body.appendChild(cursor);

    expect(replayer.fingerprint().elements).toBe(before.elements);
  });

  it('changes when the page structure changes', () => {
    document.body.innerHTML = '<div><span>a</span></div>';
    const before = replayer.fingerprint();
    document.body.innerHTML = '<div><span>a</span><p>new</p></div>';
    expect(fingerprintsDiffer(before, replayer.fingerprint())).toBe(true);
  });

  it('is safe when there is no body content', () => {
    document.body.innerHTML = '';
    expect(replayer.fingerprint()).toMatchObject({ elements: 0, textLength: 0 });
  });
});

describe('mismatch attribution', () => {
  it('only expects a DOM change for interactions the recording showed changing the DOM', () => {
    const events = [
      makeEvent({ id: 'click-with-mutation', type: 'Click', timestamp: 0 }),
      makeEvent({ id: 'mut', type: 'Mutation', timestamp: 100 }),
      makeEvent({ id: 'click-without', type: 'Click', timestamp: 5_000 }),
    ];
    internals().indexExpectedMutations(events);

    const expecting: Set<string> = internals().eventsExpectingDomChange;
    expect(expecting.has('click-with-mutation')).toBe(true);
    // The old logic flagged *every* interaction that left the DOM unchanged,
    // flooding the report with false positives.
    expect(expecting.has('click-without')).toBe(false);
  });

  it('does not attribute a mutation recorded long after the interaction', () => {
    internals().indexExpectedMutations([
      makeEvent({ id: 'click', type: 'Click', timestamp: 0 }),
      makeEvent({ id: 'mut', type: 'Mutation', timestamp: 9_000 }),
    ]);
    expect((internals().eventsExpectingDomChange as Set<string>).has('click')).toBe(false);
  });

  it('reports a mismatch only when a change was expected and none happened', async () => {
    document.body.innerHTML = '<button id="btn">Open</button>';
    const event = makeEvent({ id: 'click', type: 'Click', timestamp: 0 });

    // Not expected to change: silent.
    await internals().settle(event, 10, 'interaction');
    expect(replayer.getErrors()).toHaveLength(0);

    // Expected to change, but nothing did: reported.
    (internals().eventsExpectingDomChange as Set<string>).add('click');
    await internals().settle(event, 10, 'interaction');
    expect(replayer.getErrors()).toHaveLength(1);
    expect(replayer.getErrors()[0]).toMatchObject({ code: 'dom_mismatch', severity: 'warning' });
  });

  it('never reports a mismatch for navigation', async () => {
    const event = makeEvent({ id: 'nav', type: 'Navigation', timestamp: 0 });
    (internals().eventsExpectingDomChange as Set<string>).add('nav');
    await internals().settle(event, 10, 'navigation');
    expect(replayer.getErrors()).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('stop() is idempotent and does not accumulate wrappers', () => {
    // stop() used to rewrite itself on every start(), nesting a new closure and
    // leaking the previous keydown listener each cycle.
    const originalStop = replayer.stop;
    replayer.stop(false);
    replayer.stop(false);
    expect(replayer.stop).toBe(originalStop);
    expect(replayer.isActive()).toBe(false);
  });

  it('reports progress', () => {
    internals().scheduleEvents([
      makeEvent({ id: 'a', type: 'Click', timestamp: 0 }),
      makeEvent({ id: 'b', type: 'Click', timestamp: 10 }),
    ]);
    expect(replayer.getProgress()).toEqual({ index: 0, total: 2 });
  });

  it('ignores interceptor messages that did not come from this window', () => {
    internals().pendingNetworkRequests = 0;
    internals().onInterceptorMessage(
      new MessageEvent('message', {
        data: { source: 'replayx-interceptor', action: 'NETWORK_REQUEST_STARTED' },
        source: null,
      }),
    );
    expect(internals().pendingNetworkRequests).toBe(0);
  });

  it('tracks pending network requests without going negative', () => {
    const post = (action: string) =>
      internals().onInterceptorMessage(
        new MessageEvent('message', { data: { source: 'replayx-interceptor', action }, source: window }),
      );

    post('NETWORK_REQUEST_STARTED');
    post('NETWORK_REQUEST_STARTED');
    expect(internals().pendingNetworkRequests).toBe(2);

    post('NETWORK_REQUEST_FINISHED');
    post('NETWORK_REQUEST_FAILED');
    post('NETWORK_REQUEST_FINISHED');
    expect(internals().pendingNetworkRequests).toBe(0);
  });
});

describe('element resolution', () => {
  it('resolves via a fallback selector when the primary misses', async () => {
    document.body.innerHTML = '<button data-testid="save">Save</button>';
    const button = document.querySelector('button')!;
    button.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;

    const found = await internals().findElement(
      { selector: '#gone', fallbackSelectors: ['[data-testid="save"]'] },
      200,
    );
    expect(found).toBe(button);
  });

  it('resolves by text snippet as a last resort', async () => {
    document.body.innerHTML = '<div><span>Checkout now</span></div>';
    const span = document.querySelector('span')!;
    span.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;

    const found = await internals().findElement({ selector: '#gone', textSnippet: 'Checkout now' }, 200);
    expect(found).toBe(span);
  });

  it('returns null after the timeout instead of hanging', async () => {
    document.body.innerHTML = '<div></div>';
    const started = Date.now();
    expect(await internals().findElement({ selector: '#nope' }, 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never resolves ReplayX-owned UI as a target', async () => {
    document.body.innerHTML = `<div id="t" ${REPLAYX_UI_ATTR}="cursor"></div>`;
    expect(await internals().findElement({ selector: '#t' }, 100)).toBeNull();
  });

  it('pierces shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="inner">deep</button>';

    expect(internals().querySelectorDeep('#inner')).toBe(shadow.getElementById('inner'));
  });

  it('returns null rather than throwing on a malformed selector', () => {
    expect(internals().querySelectorDeep('###bad[[')).toBeNull();
  });

  it('treats form controls as usable even when they have no box', () => {
    document.body.innerHTML = '<input id="i"><div id="d"></div>';
    const input = document.getElementById('i') as HTMLElement;
    const div = document.getElementById('d') as HTMLElement;
    expect(internals().isUsable(input)).toBe(true);
    expect(internals().isUsable(div)).toBe(false);
  });
});

describe('form interaction', () => {
  it('sets an input value through the native setter and notifies listeners', async () => {
    document.body.innerHTML = '<input id="email" name="email">';
    const input = document.getElementById('email') as HTMLInputElement;
    input.scrollIntoView = vi.fn();
    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    input.addEventListener('input', inputSpy);
    input.addEventListener('change', changeSpy);

    await internals().executeInput(
      makeEvent({
        type: 'Input',
        payload: { selector: '#email', value: 'ada@example.com', inputType: 'text' },
      }),
    );

    expect(input.value).toBe('ada@example.com');
    expect(inputSpy).toHaveBeenCalled();
    expect(changeSpy).toHaveBeenCalled();
  });

  it('toggles a checkbox', async () => {
    document.body.innerHTML = '<input id="agree" type="checkbox">';
    const input = document.getElementById('agree') as HTMLInputElement;
    input.scrollIntoView = vi.fn();

    await internals().executeInput(
      makeEvent({ type: 'Input', payload: { selector: '#agree', value: 'true', inputType: 'checkbox' } }),
    );
    expect(input.checked).toBe(true);
  });

  it('writes into a contenteditable element', async () => {
    document.body.innerHTML = '<div id="note" contenteditable="true"></div>';
    const note = document.getElementById('note') as HTMLElement;
    note.scrollIntoView = vi.fn();
    note.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect;

    await internals().executeInput(
      makeEvent({ type: 'Input', payload: { selector: '#note', value: 'hello', inputType: 'text' } }),
    );
    expect(note.innerText).toBe('hello');
  });

  it('applies a change event value', async () => {
    document.body.innerHTML = '<select id="s"><option value="a">a</option><option value="b">b</option></select>';
    const select = document.getElementById('s') as HTMLSelectElement;

    await internals().executeChange(
      makeEvent({ type: 'Change', payload: { selector: '#s', value: 'b', inputType: 'select-one' } }),
    );
    expect(select.value).toBe('b');
  });

  it('submits a form', async () => {
    document.body.innerHTML = '<form id="f"><input name="q"></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    form.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect;
    const submitSpy = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitSpy);

    await internals().executeSubmit(makeEvent({ type: 'Submit', payload: { selector: '#f' } }));
    expect(submitSpy).toHaveBeenCalled();
  });

  it('records a missing target for each interaction kind', async () => {
    document.body.innerHTML = '<div></div>';
    await internals().executeInput(
      makeEvent({ id: 'i', type: 'Input', payload: { selector: '#gone', value: 'x', inputType: 'text' } }),
    );
    await internals().executeChange(
      makeEvent({ id: 'c', type: 'Change', payload: { selector: '#gone', value: 'x', inputType: 'text' } }),
    );
    await internals().executeSubmit(makeEvent({ id: 's', type: 'Submit', payload: { selector: '#gone' } }));

    const codes = replayer.getErrors().map((e) => e.code);
    expect(codes).toEqual(['target_not_found', 'target_not_found', 'target_not_found']);
    // Three lookups, each waiting out the full find timeout.
  }, 20_000);

  it('focuses and blurs recorded targets', async () => {
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i') as HTMLInputElement;

    await internals().executeFocusChange(makeEvent({ type: 'Focus', payload: { selector: '#i' } }));
    expect(document.activeElement).toBe(input);

    await internals().executeFocusChange(makeEvent({ type: 'Blur', payload: { selector: '#i' } }));
    expect(document.activeElement).not.toBe(input);
  });

  it('scrolls a specific element', async () => {
    document.body.innerHTML = '<div id="pane">x</div>';
    const pane = document.getElementById('pane') as HTMLElement;
    pane.getBoundingClientRect = () => ({ width: 100, height: 100 }) as DOMRect;
    const scrollSpy = vi.fn();
    pane.addEventListener('scroll', scrollSpy);

    await internals().executeScroll(
      makeEvent({ type: 'Scroll', payload: { selector: '#pane', scrollTop: 40, scrollLeft: 0 } }),
    );
    expect(pane.scrollTop).toBe(40);
    expect(scrollSpy).toHaveBeenCalled();
  });
});

describe('retry behaviour', () => {
  it('retries a failing operation and eventually succeeds', async () => {
    let attempts = 0;
    const run = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('not yet');
      return 'ok';
    });

    const result = await internals().withRetry(makeEvent({ id: 'r', type: 'Click' }), run);
    expect(result).toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('gives up after the retry limit', async () => {
    const run = vi.fn(async () => {
      throw new Error('always fails');
    });
    await expect(internals().withRetry(makeEvent({ id: 'r', type: 'Click' }), run)).rejects.toThrow(
      'always fails',
    );
    expect(run).toHaveBeenCalledTimes(4); // initial attempt plus three retries
  }, 15_000);
});

describe('executeEvent dispatch', () => {
  it('records a failure once, not twice', async () => {
    // executeEvent and the replay loop both used to record the same failure.
    document.body.innerHTML = '';
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: () => {
        throw new Error('boom');
      },
    });

    await expect(
      internals().executeEvent(
        makeEvent({
          id: 'x',
          type: 'Scroll',
          payload: { selector: 'window', scrollTop: 0, scrollLeft: 0 },
        }),
      ),
    ).rejects.toThrow('boom');
    expect(replayer.getErrors().filter((e) => e.code === 'event_failed')).toHaveLength(1);
  });

  it('does not throw for an unrecognised event type', async () => {
    await expect(internals().executeEvent(makeEvent({ type: 'Bogus' as never }))).resolves.toBe(false);
  });
});

describe('storage restoration', () => {
  it('restores only the keys the recording captured', () => {
    localStorage.setItem('keep-me', 'yes');
    localStorage.setItem('theme', 'light');

    internals().restoreInitialState({
      id: 's',
      url: window.location.href,
      startTime: 0,
      events: [],
      metadata: {},
      initialState: {
        url: window.location.href,
        viewport: { width: 1, height: 1 },
        localStorage: { theme: 'dark' },
        sessionStorage: {},
      },
    });

    expect(localStorage.getItem('theme')).toBe('dark');
    // Unrelated user data must survive.
    expect(localStorage.getItem('keep-me')).toBe('yes');
    localStorage.clear();
  });
});
