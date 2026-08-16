import { describe, expect, it } from 'vitest';
import { collapseTimeline, getEventDetailSummary, getReplayStatusBadge, summarizeEvent } from './debugger';
import type { RecordedEvent } from './types';

const event = (
  type: RecordedEvent['type'],
  payload: Record<string, unknown>,
  timestamp = 0,
): RecordedEvent => ({ id: 'e', sessionId: 's', timestamp, type, payload }) as unknown as RecordedEvent;

describe('getReplayStatusBadge', () => {
  it('warns when replay issues exist', () => {
    const badge = getReplayStatusBadge({
      replayErrors: [{ message: 'Mismatch' }],
      metadata: { replayIssues: 1 } as never,
    });
    expect(badge).toMatchObject({ label: 'Issues', variant: 'warning', count: 1 });
  });

  it('falls back to the metadata counter when errors were not persisted', () => {
    const badge = getReplayStatusBadge({ metadata: { replayIssues: 3 } as never });
    expect(badge.count).toBe(3);
  });

  it('reports healthy when there are no issues', () => {
    expect(getReplayStatusBadge({ replayErrors: [], metadata: {} as never })).toMatchObject({
      label: 'Healthy',
      variant: 'success',
      count: 0,
    });
  });
});

describe('getEventDetailSummary', () => {
  it('describes a network event', () => {
    const detail = getEventDetailSummary(
      event('Network', {
        method: 'GET',
        url: 'https://example.com/api',
        responseStatus: 200,
        duration: 120,
        requestBody: '{"q":"hi"}',
        responseBody: '{"ok":true}',
      }),
    );
    expect(detail.title).toBe('GET https://example.com/api');
    expect(detail.meta).toContain('200');
    expect(detail.meta).toContain('120ms');
    expect(detail.body).toContain('Request');
    expect(detail.body).toContain('Response');
  });

  it('flags a truncated network body', () => {
    const detail = getEventDetailSummary(
      event('Network', { method: 'GET', url: '/x', responseStatus: 200, truncated: true }),
    );
    expect(detail.meta).toContain('truncated');
  });

  it('reports masked input values instead of leaking them', () => {
    const detail = getEventDetailSummary(
      event('Input', { selector: '#pw', value: '********', masked: true, inputType: 'password' }),
    );
    expect(detail.meta).toMatch(/masked/i);
    expect(detail.meta).not.toContain('********');
  });

  it('shows ordinary input values', () => {
    const detail = getEventDetailSummary(
      event('Input', { selector: '#name', value: 'Ada', inputType: 'text' }),
    );
    expect(detail.meta).toContain('Ada');
  });

  it('describes clicks, submits, navigation and scroll', () => {
    expect(getEventDetailSummary(event('Click', { selector: '#a', x: 1, y: 2 })).title).toContain('#a');
    expect(getEventDetailSummary(event('Submit', { selector: 'form', formAction: '/go' })).meta).toContain('/go');
    expect(
      getEventDetailSummary(event('Navigation', { url: 'https://a.test', navigationType: 'push' })).meta,
    ).toBe('push');
    expect(getEventDetailSummary(event('Scroll', { selector: 'window', scrollTop: 10, scrollLeft: 0 })).meta).toContain(
      'top 10',
    );
  });

  it('describes a resize', () => {
    const detail = getEventDetailSummary(event('Resize', { width: 100, height: 100 }));
    expect(detail.title).toBe('Resize');
    expect(detail.meta).toBe('100 x 100');
  });

  it('falls back gracefully for a type written by another build', () => {
    // Only reachable for session data from a future or older version.
    const detail = getEventDetailSummary(event('Teleport' as RecordedEvent['type'], {}));
    expect(detail.title).toBe('Teleport');
    expect(detail.meta).toBe('No additional detail');
  });

  it('truncates long values', () => {
    const detail = getEventDetailSummary(
      event('Network', { method: 'GET', url: '/x', responseStatus: 200, responseBody: 'y'.repeat(500) }),
    );
    expect(detail.body.length).toBeLessThan(300);
  });
});

describe('summarizeEvent', () => {
  it('produces a single line for the timeline', () => {
    const line = summarizeEvent(event('Click', { selector: '#a', x: 1, y: 2, textSnippet: 'Save' }));
    expect(line).toContain('Save');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('every event type is describable', () => {
  const ALL_TYPES: RecordedEvent['type'][] = [
    'Click',
    'DoubleClick',
    'Input',
    'Change',
    'Submit',
    'Scroll',
    'Mutation',
    'Navigation',
    'Network',
    'Key',
    'Resize',
    'Focus',
    'Blur',
  ];

  it.each(ALL_TYPES)('%s never renders as "No additional detail"', (type) => {
    // Mutation, Key, Resize, Focus and Blur all fell through to a default that
    // read `payload.selector`. Mutation payloads use `targetSelector`, so DOM
    // mutations could never be described at all.
    const detail = getEventDetailSummary(
      event(type, {
        selector: '#a',
        targetSelector: '#a',
        type: 'childList',
        key: 'a',
        kind: 'down',
        width: 100,
        height: 100,
        url: 'https://a.test',
        method: 'GET',
        responseStatus: 200,
        value: 'x',
        scrollTop: 0,
        scrollLeft: 0,
        x: 0,
        y: 0,
      }),
    );
    expect(detail.title).toBeTruthy();
    expect(detail.meta).not.toBe('No additional detail');
  });
});

describe('mutation summaries', () => {
  it('describes added and removed nodes', () => {
    const detail = getEventDetailSummary(
      event('Mutation', {
        type: 'childList',
        targetSelector: '#content',
        addedNodes: ['<p>one</p>', '<p>two</p>'],
        removedNodes: ['<span>old</span>'],
      }),
    );
    expect(detail.title).toBe('Mutation (childList)');
    expect(detail.meta).toContain('#content');
    expect(detail.meta).toContain('+2 nodes');
    expect(detail.meta).toContain('-1');
  });

  it('describes an attribute change', () => {
    const detail = getEventDetailSummary(
      event('Mutation', {
        type: 'attributes',
        targetSelector: '#nav',
        attributeName: 'class',
        attributeValue: 'open',
        oldValue: 'closed',
      }),
    );
    expect(detail.meta).toContain('class changed');
    expect(detail.body).toContain('closed');
    expect(detail.body).toContain('open');
  });

  it('describes a text change', () => {
    const detail = getEventDetailSummary(
      event('Mutation', {
        type: 'characterData',
        targetSelector: '#count',
        oldValue: '1',
        newValue: '2',
      }),
    );
    expect(detail.meta).toContain('text changed');
    expect(detail.body).toContain('2');
  });

  it('handles a childList mutation with no net change', () => {
    const detail = getEventDetailSummary(
      event('Mutation', { type: 'childList', targetSelector: '#x' }),
    );
    expect(detail.meta).toContain('no net change');
  });
});

describe('key summaries', () => {
  it('renders a modifier combination', () => {
    const detail = getEventDetailSummary(
      event('Key', { kind: 'down', key: 'S', ctrlKey: true, shiftKey: true, code: 'KeyS' }),
    );
    expect(detail.title).toBe('Key down');
    expect(detail.meta).toBe('Ctrl+Shift+S');
    expect(detail.body).toContain('KeyS');
  });

  it('distinguishes keyup from keydown', () => {
    expect(getEventDetailSummary(event('Key', { kind: 'up', key: 'a' })).title).toBe('Key up');
  });
});

describe('collapseTimeline', () => {
  const mutation = (timestamp: number): RecordedEvent =>
    event('Mutation', { type: 'childList', targetSelector: '#x' }, timestamp);
  const click = (timestamp: number): RecordedEvent =>
    event('Click', { selector: '#b', x: 0, y: 0 }, timestamp);

  it('collapses a run of consecutive mutations into one entry', () => {
    // A page load emits mutations in bursts; one row each pushed the user's
    // actual clicks off the end of the timeline.
    const events = [mutation(100), mutation(150), mutation(200), click(300)];
    const entries = collapseTimeline(events);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'run', count: 3, from: 100, to: 200 });
    expect(entries[1]).toMatchObject({ kind: 'event' });
  });

  it('leaves an isolated mutation as a full entry', () => {
    const entries = collapseTimeline([click(0), mutation(100), click(200)]);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.kind === 'event')).toBe(true);
  });

  it('keeps interactions visible despite a large mutation burst', () => {
    const burst = Array.from({ length: 400 }, (_, i) => mutation(i));
    const entries = collapseTimeline([...burst, click(500), click(600)], 25);

    // The burst costs a single row, so both clicks still make the cut.
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'run', count: 400 });
    expect(entries.filter((e) => e.kind === 'event')).toHaveLength(2);
  });

  it('respects the entry limit', () => {
    const events = Array.from({ length: 100 }, (_, i) => click(i));
    expect(collapseTimeline(events, 10)).toHaveLength(10);
  });

  it('handles an empty event list', () => {
    expect(collapseTimeline([])).toEqual([]);
  });
});
