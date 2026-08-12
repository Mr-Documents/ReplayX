import type { EventChunk, RecordedEvent, ReplayErrorEntry, SessionData, SessionSummary } from '../types';

const DB_NAME = 'ReplayXDB';
const DB_VERSION = 3;
const SESSIONS_STORE = 'sessions';
const LEGACY_EVENTS_STORE = 'events';
const CHUNKS_STORE = 'chunks';

const CHUNK_SIZE = 500; // Events per chunk

// Data retention policy
export const MAX_SESSIONS = 100;
export const MAX_SESSION_AGE_DAYS = 30;
export const CLEANUP_ALARM_NAME = 'replayx-retention-cleanup';
export const CLEANUP_INTERVAL_MINUTES = 60 * 24; // daily

/**
 * A single cached connection. Re-opening IndexedDB per call (the previous
 * behaviour) cost a full open handshake on every read and leaked one connection
 * per operation, which also blocked future `onupgradeneeded` transitions.
 */
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this context'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessionsStore = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        sessionsStore.createIndex('startTime', 'startTime');
        sessionsStore.createIndex('url', 'url');
      }

      // Retained read-only so sessions written by v2 remain loadable.
      if (!db.objectStoreNames.contains(LEGACY_EVENTS_STORE)) {
        const eventsStore = db.createObjectStore(LEGACY_EVENTS_STORE, { keyPath: 'id' });
        eventsStore.createIndex('sessionId', 'sessionId');
      }

      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunksStore = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        chunksStore.createIndex('sessionId', 'sessionId');
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another context upgrades the schema, drop our handle so it is not
      // left blocking, and let the next call re-open.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open ReplayX database'));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('ReplayX database upgrade blocked by another open connection'));
    };
  });

  return dbPromise;
}

/** Test seam: forces the next call to re-open the database. */
export function resetDbConnection(): void {
  dbPromise = null;
}

/**
 * Resolves only when the whole transaction commits. Resolving on individual
 * request callbacks (the previous behaviour) reported success before the data
 * was durable, and never resolved at all when there were zero requests.
 */
function runTransaction<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let result: T;
    try {
      tx = db.transaction(stores, mode);
      result = work(tx);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('A non-empty session id is required');
  }
}

/**
 * Min/max over the event stream without `Math.max(...events)`: spreading a
 * 50k-element array overflows the call stack, and spreading an empty one
 * yields `-Infinity - Infinity = NaN`.
 */
export function computeDuration(events: readonly RecordedEvent[]): number {
  if (events.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const event of events) {
    const t = event.timestamp;
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  return max - min;
}

function toChunks(sessionId: string, events: readonly RecordedEvent[]): EventChunk[] {
  const chunks: EventChunk[] = [];
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunkId = Math.floor(i / CHUNK_SIZE);
    chunks.push({
      id: `${sessionId}::${chunkId}`,
      sessionId,
      chunkId,
      events: events.slice(i, i + CHUNK_SIZE),
      compressed: false,
    });
  }
  return chunks;
}

function toSummary(session: SessionData): SessionSummary {
  const { events: _events, ...rest } = session as SessionData & { events?: RecordedEvent[] };
  void _events;
  return rest as SessionSummary;
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

/**
 * Writes the session record and its events atomically. Events always live in
 * the chunk store; the previous code chose between two stores by size, so a
 * session that shrank below the threshold kept serving stale chunked events.
 */
export async function saveSession(session: SessionData): Promise<void> {
  if (!session || typeof session !== 'object') {
    throw new TypeError('saveSession requires a session object');
  }
  assertSessionId(session.id);

  const events = Array.isArray(session.events) ? session.events : [];
  const record: SessionSummary = {
    ...toSummary(session),
    metadata: {
      ...session.metadata,
      totalEvents: events.length,
      duration: session.metadata?.duration ?? computeDuration(events),
    },
  };
  const chunks = toChunks(session.id, events);

  const db = await openDB();
  const keepKeys = new Set(chunks.map((chunk) => chunk.id));

  await runTransaction(db, [SESSIONS_STORE, CHUNKS_STORE, LEGACY_EVENTS_STORE], 'readwrite', (tx) => {
    tx.objectStore(SESSIONS_STORE).put(record);
    const chunkStore = tx.objectStore(CHUNKS_STORE);

    // Replace, never merge: leftover chunks from a longer previous write would
    // otherwise resurface as phantom trailing events. Surplus keys are deleted
    // explicitly rather than by cursor, because a cursor walk interleaved with
    // the puts below could delete a chunk we just wrote.
    const existingKeys = chunkStore.index('sessionId').getAllKeys(session.id);
    existingKeys.onsuccess = () => {
      for (const key of existingKeys.result) {
        if (!keepKeys.has(String(key))) chunkStore.delete(key);
      }
    };

    for (const chunk of chunks) chunkStore.put(chunk);
    // Nothing is ever written to the legacy store, so a cursor sweep is safe.
    deleteByIndexCursor(tx.objectStore(LEGACY_EVENTS_STORE), 'sessionId', session.id);
  });
}

/**
 * Appends events to an existing session without rewriting the ones already
 * stored. Recording flushes go straight to disk through this, so an MV3
 * service-worker suspension can no longer lose the in-memory event buffer.
 */
export async function appendSessionEvents(sessionId: string, events: RecordedEvent[]): Promise<number> {
  assertSessionId(sessionId);
  if (!Array.isArray(events) || events.length === 0) return 0;

  const db = await openDB();
  await runTransaction(db, [SESSIONS_STORE, CHUNKS_STORE], 'readwrite', (tx) => {
    const chunkStore = tx.objectStore(CHUNKS_STORE);
    const keysRequest = chunkStore.index('sessionId').getAllKeys(sessionId);

    keysRequest.onsuccess = () => {
      let nextChunkId = 0;
      for (const key of keysRequest.result) {
        const suffix = Number.parseInt(String(key).split('::')[1] ?? '', 10);
        if (Number.isFinite(suffix) && suffix >= nextChunkId) nextChunkId = suffix + 1;
      }
      for (let i = 0; i < events.length; i += CHUNK_SIZE) {
        const chunkId = nextChunkId++;
        chunkStore.put({
          id: `${sessionId}::${chunkId}`,
          sessionId,
          chunkId,
          events: events.slice(i, i + CHUNK_SIZE),
          compressed: false,
        } satisfies EventChunk);
      }
    };

    const sessionStore = tx.objectStore(SESSIONS_STORE);
    const sessionRequest = sessionStore.get(sessionId);
    sessionRequest.onsuccess = () => {
      const existing = sessionRequest.result as SessionSummary | undefined;
      if (!existing) return;
      sessionStore.put({
        ...existing,
        metadata: {
          ...existing.metadata,
          totalEvents: (existing.metadata?.totalEvents ?? 0) + events.length,
        },
      });
    };
  });

  return events.length;
}

/** Merges a partial metadata patch into an existing session record. */
export async function updateSessionMetadata(
  sessionId: string,
  patch: Partial<SessionSummary> & { metadata?: Partial<SessionSummary['metadata']> },
): Promise<void> {
  assertSessionId(sessionId);
  const db = await openDB();
  await runTransaction(db, SESSIONS_STORE, 'readwrite', (tx) => {
    const store = tx.objectStore(SESSIONS_STORE);
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const existing = request.result as SessionSummary | undefined;
      if (!existing) return;
      store.put({
        ...existing,
        ...patch,
        metadata: { ...existing.metadata, ...(patch.metadata ?? {}) },
      });
    };
  });
}

/** Updates only the replay diagnostics, without rewriting every event. */
export async function updateSessionReplayResults(
  sessionId: string,
  replayErrors: ReplayErrorEntry[],
): Promise<void> {
  assertSessionId(sessionId);
  const db = await openDB();
  await runTransaction(db, SESSIONS_STORE, 'readwrite', (tx) => {
    const store = tx.objectStore(SESSIONS_STORE);
    const getRequest = store.get(sessionId);
    getRequest.onsuccess = () => {
      const existing = getRequest.result as SessionSummary | undefined;
      if (!existing) return;
      store.put({
        ...existing,
        replayErrors,
        metadata: { ...existing.metadata, replayIssues: replayErrors.length },
      });
    };
  });
}

/** Session records only - no events are loaded. Used by the popup list. */
export async function getSessionSummaries(): Promise<SessionSummary[]> {
  const db = await openDB();
  const sessions = await unwrap(
    runTransaction(db, SESSIONS_STORE, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(SESSIONS_STORE).getAll() as IDBRequest<SessionSummary[]>),
    ),
  );
  return sessions.sort((a, b) => b.startTime - a.startTime);
}

/**
 * Loads every session with its events using a fixed number of transactions.
 * The previous implementation opened a new connection and two transactions per
 * session, i.e. O(n) database opens for a single list render.
 */
export async function getSessions(): Promise<SessionData[]> {
  const db = await openDB();

  const [sessions, chunks, legacyEvents] = await unwrap(
    runTransaction(db, [SESSIONS_STORE, CHUNKS_STORE, LEGACY_EVENTS_STORE], 'readonly', (tx) =>
      Promise.all([
        requestToPromise(tx.objectStore(SESSIONS_STORE).getAll() as IDBRequest<SessionSummary[]>),
        requestToPromise(tx.objectStore(CHUNKS_STORE).getAll() as IDBRequest<EventChunk[]>),
        requestToPromise(tx.objectStore(LEGACY_EVENTS_STORE).getAll() as IDBRequest<RecordedEvent[]>),
      ]),
    ),
  );

  const bySession = groupEvents(chunks, legacyEvents);
  return sessions
    .map((session) => ({ ...session, events: bySession.get(session.id) ?? [] }) as SessionData)
    .sort((a, b) => b.startTime - a.startTime);
}

export async function getSession(id: string): Promise<SessionData | null> {
  assertSessionId(id);
  const db = await openDB();

  const [session, chunks, legacyEvents] = await unwrap(
    runTransaction(db, [SESSIONS_STORE, CHUNKS_STORE, LEGACY_EVENTS_STORE], 'readonly', (tx) =>
      Promise.all([
        requestToPromise(tx.objectStore(SESSIONS_STORE).get(id) as IDBRequest<SessionSummary | undefined>),
        requestToPromise(
          tx.objectStore(CHUNKS_STORE).index('sessionId').getAll(id) as IDBRequest<EventChunk[]>,
        ),
        requestToPromise(
          tx.objectStore(LEGACY_EVENTS_STORE).index('sessionId').getAll(id) as IDBRequest<RecordedEvent[]>,
        ),
      ]),
    ),
  );

  if (!session) return null;
  const events = groupEvents(chunks, legacyEvents).get(id) ?? [];
  return { ...session, events } as SessionData;
}

export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id);
  const db = await openDB();
  await runTransaction(db, [SESSIONS_STORE, CHUNKS_STORE, LEGACY_EVENTS_STORE], 'readwrite', (tx) => {
    tx.objectStore(SESSIONS_STORE).delete(id);
    deleteByIndexCursor(tx.objectStore(CHUNKS_STORE), 'sessionId', id);
    deleteByIndexCursor(tx.objectStore(LEGACY_EVENTS_STORE), 'sessionId', id);
  });
}

/**
 * Enforces the retention policy in one transaction. Deletions are issued
 * eagerly and completion is signalled by the transaction commit, so no session
 * can be reported as cleaned up before its events are actually gone.
 */
export async function cleanupOldSessions(now: number = Date.now()): Promise<number> {
  const db = await openDB();
  const summaries = await getSessionSummaries();

  const maxAgeMs = MAX_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;
  const doomed = new Set<string>();

  for (const session of summaries) {
    if (now - (session.startTime || 0) > maxAgeMs) doomed.add(session.id);
  }

  // getSessionSummaries is newest-first, so the tail is the oldest.
  const survivors = summaries.filter((session) => !doomed.has(session.id));
  for (const session of survivors.slice(MAX_SESSIONS)) doomed.add(session.id);

  if (doomed.size === 0) return 0;

  await runTransaction(db, [SESSIONS_STORE, CHUNKS_STORE, LEGACY_EVENTS_STORE], 'readwrite', (tx) => {
    const sessionStore = tx.objectStore(SESSIONS_STORE);
    const chunkStore = tx.objectStore(CHUNKS_STORE);
    const legacyStore = tx.objectStore(LEGACY_EVENTS_STORE);
    for (const id of doomed) {
      sessionStore.delete(id);
      deleteByIndexCursor(chunkStore, 'sessionId', id);
      deleteByIndexCursor(legacyStore, 'sessionId', id);
    }
  });

  console.info(`[ReplayX DB] Retention cleanup removed ${doomed.size} session(s)`);
  return doomed.size;
}

/**
 * Registers the retention sweep on a chrome alarm. `setInterval` (the previous
 * approach) does not survive MV3 service-worker suspension, so the daily
 * cleanup effectively never ran.
 */
export function scheduleAutoCleanup(): void {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  chrome.alarms.create(CLEANUP_ALARM_NAME, { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLEANUP_ALARM_NAME) return;
    cleanupOldSessions().catch((error) => {
      console.error('[ReplayX DB] Auto-cleanup failed:', error);
    });
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `runTransaction` resolves with whatever `work` returned; here that is a promise. */
function unwrap<T>(pending: Promise<Promise<T>>): Promise<T> {
  return pending.then((inner) => inner);
}

function deleteByIndexCursor(store: IDBObjectStore, indexName: string, key: IDBValidKey): void {
  if (!store.indexNames.contains(indexName)) return;
  const cursorRequest = store.index(indexName).openCursor(IDBKeyRange.only(key));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

function groupEvents(chunks: EventChunk[], legacyEvents: RecordedEvent[]): Map<string, RecordedEvent[]> {
  const chunksBySession = new Map<string, EventChunk[]>();
  for (const chunk of chunks) {
    const list = chunksBySession.get(chunk.sessionId);
    if (list) list.push(chunk);
    else chunksBySession.set(chunk.sessionId, [chunk]);
  }

  const result = new Map<string, RecordedEvent[]>();
  for (const [sessionId, sessionChunks] of chunksBySession) {
    sessionChunks.sort((a, b) => a.chunkId - b.chunkId);
    const events: RecordedEvent[] = [];
    for (const chunk of sessionChunks) events.push(...chunk.events);
    result.set(sessionId, events);
  }

  // Legacy (v2) rows are only consulted for sessions that have no chunks at all.
  const legacyBySession = new Map<string, RecordedEvent[]>();
  for (const event of legacyEvents) {
    if (chunksBySession.has(event.sessionId)) continue;
    const list = legacyBySession.get(event.sessionId);
    if (list) list.push(event);
    else legacyBySession.set(event.sessionId, [event]);
  }
  for (const [sessionId, events] of legacyBySession) {
    // The legacy store has no ordering guarantee; restore recording order.
    events.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.timestamp - b.timestamp);
    result.set(sessionId, events);
  }

  return result;
}
