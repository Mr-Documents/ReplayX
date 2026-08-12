import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendSessionEvents,
  cleanupOldSessions,
  computeDuration,
  deleteSession,
  getSession,
  getSessions,
  getSessionSummaries,
  MAX_SESSIONS,
  resetDbConnection,
  saveSession,
  updateSessionMetadata,
  updateSessionReplayResults,
} from './db';
import type { RecordedEvent, SessionData } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEvent(index: number, sessionId: string): RecordedEvent {
  return {
    id: `event-${index}`,
    sessionId,
    sequence: index,
    timestamp: index * 10,
    type: 'Click',
    payload: { selector: `#el-${index}`, x: index, y: index },
  } as RecordedEvent;
}

function makeSession(id: string, overrides: Partial<SessionData> = {}): SessionData {
  return {
    id,
    url: 'https://example.com/app',
    startTime: Date.now(),
    endTime: Date.now() + 1000,
    events: [],
    metadata: {
      userAgent: 'test-agent',
      viewport: { width: 1920, height: 1080 },
      totalEvents: 0,
      duration: 0,
      pageUrls: ['https://example.com/app'],
    },
    ...overrides,
  };
}

beforeEach(() => {
  // The global setup swaps in a fresh IDBFactory; drop the cached handle to it.
  resetDbConnection();
});

describe('computeDuration', () => {
  it('returns 0 for an empty event list instead of NaN', () => {
    expect(computeDuration([])).toBe(0);
  });

  it('returns the span between the first and last timestamps', () => {
    expect(computeDuration([makeEvent(0, 's'), makeEvent(5, 's'), makeEvent(2, 's')])).toBe(50);
  });

  it('handles very large event counts without overflowing the call stack', () => {
    // Math.max(...events) threw RangeError past ~120k arguments.
    const events = Array.from({ length: 200_000 }, (_, i) => makeEvent(i, 's'));
    expect(computeDuration(events)).toBe(1_999_990);
  });
});

describe('session CRUD', () => {
  it('saves and reloads a session', async () => {
    await saveSession(makeSession('s1'));
    const loaded = await getSession('s1');
    expect(loaded?.id).toBe('s1');
    expect(loaded?.url).toBe('https://example.com/app');
  });

  it('resolves rather than hanging when a session has zero events', async () => {
    // The previous implementation never resolved its save promise for an empty
    // event array, so stopping an empty recording hung forever.
    await expect(saveSession(makeSession('empty'))).resolves.toBeUndefined();
    expect((await getSession('empty'))?.events).toEqual([]);
  });

  it('returns null for an unknown session', async () => {
    expect(await getSession('nope')).toBeNull();
  });

  it('rejects an empty session id', async () => {
    await expect(deleteSession('')).rejects.toThrow(/non-empty session id/i);
    await expect(getSession('')).rejects.toThrow(/non-empty session id/i);
  });

  it('rejects a non-object session', async () => {
    await expect(saveSession(null as unknown as SessionData)).rejects.toThrow();
  });

  it('round-trips events in recorded order', async () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent(i, 's2'));
    await saveSession(makeSession('s2', { events }));
    const loaded = await getSession('s2');
    expect(loaded?.events.map((e) => e.id)).toEqual(['event-0', 'event-1', 'event-2', 'event-3', 'event-4']);
  });

  it('stores sessions larger than a single chunk', async () => {
    const events = Array.from({ length: 1_200 }, (_, i) => makeEvent(i, 'big'));
    await saveSession(makeSession('big', { events }));
    const loaded = await getSession('big');
    expect(loaded?.events).toHaveLength(1_200);
    expect(loaded?.events[0]?.id).toBe('event-0');
    expect(loaded?.events[1_199]?.id).toBe('event-1199');
  });

  it('does not resurrect events from a longer previous save', async () => {
    // Chunks were previously left behind when a session was re-saved smaller,
    // so the stale tail reappeared as phantom trailing events.
    await saveSession(makeSession('shrink', { events: Array.from({ length: 1_500 }, (_, i) => makeEvent(i, 'shrink')) }));
    await saveSession(makeSession('shrink', { events: [makeEvent(0, 'shrink')] }));
    const loaded = await getSession('shrink');
    expect(loaded?.events).toHaveLength(1);
  });

  it('deletes a session and its events', async () => {
    await saveSession(makeSession('gone', { events: [makeEvent(0, 'gone')] }));
    await deleteSession('gone');
    expect(await getSession('gone')).toBeNull();
  });

  it('lists sessions newest first', async () => {
    await saveSession(makeSession('older', { startTime: 1_000 }));
    await saveSession(makeSession('newer', { startTime: 2_000 }));
    const summaries = await getSessionSummaries();
    expect(summaries.map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('omits events from summaries but includes them in full loads', async () => {
    await saveSession(makeSession('s3', { events: [makeEvent(0, 's3'), makeEvent(1, 's3')] }));
    const [summary] = await getSessionSummaries();
    expect(summary?.events).toBeUndefined();
    expect(summary?.metadata.totalEvents).toBe(2);

    const [full] = await getSessions();
    expect(full?.events).toHaveLength(2);
  });

  it('supports concurrent reads and writes', async () => {
    const session = makeSession('concurrent');
    await expect(
      Promise.all([saveSession(session), getSessionSummaries(), getSessions()]),
    ).resolves.toBeDefined();
  });
});

describe('appendSessionEvents', () => {
  it('appends without rewriting existing events', async () => {
    await saveSession(makeSession('append', { events: [makeEvent(0, 'append')] }));
    await appendSessionEvents('append', [makeEvent(1, 'append'), makeEvent(2, 'append')]);
    const loaded = await getSession('append');
    expect(loaded?.events.map((e) => e.id)).toEqual(['event-0', 'event-1', 'event-2']);
    expect(loaded?.metadata.totalEvents).toBe(3);
  });

  it('preserves order across many appends', async () => {
    await saveSession(makeSession('many'));
    for (let batch = 0; batch < 5; batch++) {
      await appendSessionEvents(
        'many',
        Array.from({ length: 3 }, (_, i) => makeEvent(batch * 3 + i, 'many')),
      );
    }
    const loaded = await getSession('many');
    expect(loaded?.events.map((e) => e.id)).toEqual(
      Array.from({ length: 15 }, (_, i) => `event-${i}`),
    );
  });

  it('is a no-op for an empty batch', async () => {
    await saveSession(makeSession('noop'));
    expect(await appendSessionEvents('noop', [])).toBe(0);
  });
});

describe('metadata updates', () => {
  it('updates replay diagnostics without touching events', async () => {
    await saveSession(makeSession('diag', { events: [makeEvent(0, 'diag'), makeEvent(1, 'diag')] }));
    await updateSessionReplayResults('diag', [{ code: 'dom_mismatch', message: 'no change' }]);
    const loaded = await getSession('diag');
    expect(loaded?.replayErrors).toHaveLength(1);
    expect(loaded?.metadata.replayIssues).toBe(1);
    expect(loaded?.events).toHaveLength(2);
  });

  it('merges a partial metadata patch', async () => {
    await saveSession(makeSession('patch'));
    await updateSessionMetadata('patch', { endTime: 42, metadata: { duration: 99 } } as never);
    const loaded = await getSession('patch');
    expect(loaded?.endTime).toBe(42);
    expect(loaded?.metadata.duration).toBe(99);
    expect(loaded?.metadata.userAgent).toBe('test-agent');
  });

  it('ignores updates for sessions that do not exist', async () => {
    await expect(updateSessionReplayResults('ghost', [])).resolves.toBeUndefined();
  });
});

describe('retention cleanup', () => {
  it('deletes sessions older than the retention window and keeps recent ones', async () => {
    const now = Date.now();
    await saveSession(makeSession('old', { startTime: now - 40 * DAY_MS }));
    await saveSession(makeSession('recent', { startTime: now - 10 * DAY_MS }));

    expect(await cleanupOldSessions(now)).toBe(1);
    expect(await getSession('old')).toBeNull();
    expect(await getSession('recent')).not.toBeNull();
  });

  it('removes the events of a deleted session too', async () => {
    const now = Date.now();
    await saveSession(
      makeSession('oldWithEvents', {
        startTime: now - 40 * DAY_MS,
        events: [makeEvent(0, 'oldWithEvents')],
      }),
    );
    await cleanupOldSessions(now);
    // If chunks survived, this session id would still resolve events.
    const all = await getSessions();
    expect(all.find((s) => s.id === 'oldWithEvents')).toBeUndefined();
  });

  it('enforces the maximum session count, keeping the newest', async () => {
    const now = Date.now();
    for (let i = 0; i < MAX_SESSIONS + 20; i++) {
      await saveSession(makeSession(`bulk-${i}`, { startTime: now - i * 1000 }));
    }
    const removed = await cleanupOldSessions(now);
    expect(removed).toBe(20);

    const remaining = await getSessionSummaries();
    expect(remaining).toHaveLength(MAX_SESSIONS);
    expect(remaining[0]?.id).toBe('bulk-0');
  });

  it('reports zero when nothing needs removing', async () => {
    await saveSession(makeSession('fresh'));
    expect(await cleanupOldSessions(Date.now())).toBe(0);
  });
});
