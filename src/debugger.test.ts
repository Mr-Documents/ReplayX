import { describe, expect, it } from 'vitest';
import { getEventDetailSummary, getReplayStatusBadge, summarizeEvent } from './debugger';
import type { RecordedEvent } from './types';

const event = (type: RecordedEvent['type'], payload: Record<string, unknown>): RecordedEvent =>
  ({ id: 'e', sessionId: 's', timestamp: 0, type, payload }) as unknown as RecordedEvent;

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

  it('falls back gracefully for unhandled types', () => {
    const detail = getEventDetailSummary(event('Resize', { width: 100, height: 100 }));
    expect(detail.title).toBe('Resize');
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
