import { describe, expect, it } from 'vitest';
import { getReplayStatusBadge, getEventDetailSummary } from './debugger';

describe('debugger helpers', () => {
  it('returns a warning badge when replay issues exist', () => {
    const badge = getReplayStatusBadge({
      replayErrors: [{ message: 'Mismatch' }],
      metadata: { replayIssues: 1 } as any
    } as any);

    expect(badge.label).toBe('Issues');
    expect(badge.variant).toBe('warning');
  });

  it('builds a readable detail summary for network events', () => {
    const detail = getEventDetailSummary({
      type: 'Network',
      payload: {
        method: 'GET',
        url: 'https://example.com/api',
        responseStatus: 200,
        duration: 120,
        requestBody: '{"q":"hi"}',
        responseBody: '{"ok":true}'
      }
    } as any);

    expect(detail.title).toContain('GET https://example.com/api');
    expect(detail.meta).toContain('200');
    expect(detail.meta).toContain('120ms');
    expect(detail.body).toContain('Request');
    expect(detail.body).toContain('Response');
  });
});
