import { SessionData, RecordedEvent, EventChunk } from '../types';

const DB_NAME = 'ReplayXDB';
const DB_VERSION = 2; // Increment for schema changes
const SESSIONS_STORE = 'sessions';
const EVENTS_STORE = 'events';
const CHUNKS_STORE = 'chunks';

const CHUNK_SIZE = 100; // Events per chunk
const COMPRESSION_THRESHOLD = 1024; // Compress if payload > 1KB

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Sessions store
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessionsStore = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        sessionsStore.createIndex('startTime', 'startTime');
        sessionsStore.createIndex('url', 'url');
      }

      // Events store (append-only)
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const eventsStore = db.createObjectStore(EVENTS_STORE, { keyPath: 'id' });
        eventsStore.createIndex('sessionId', 'sessionId');
        eventsStore.createIndex('timestamp', 'timestamp');
        eventsStore.createIndex('type', 'type');
      }

      // Chunks store for large sessions
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunksStore = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        chunksStore.createIndex('sessionId', 'sessionId');
        chunksStore.createIndex('chunkId', 'chunkId');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Session operations
export async function saveSession(session: SessionData): Promise<void> {
  const db = await openDB();

  // Save session metadata
  const sessionData = {
    ...session,
    events: [], // Don't store events in session, use separate store
    totalEvents: session.events.length,
    duration: Math.max(...session.events.map(e => e.timestamp)) - Math.min(...session.events.map(e => e.timestamp))
  };

  // Save events in chunks if large
  if (session.events.length > CHUNK_SIZE) {
    await saveEventsInChunks(session.id, session.events);
  } else {
    await saveEvents(session.events);
  }

  // Save session
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.put(sessionData);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getSessions(): Promise<SessionData[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readonly');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.getAll();

    request.onsuccess = async () => {
      const sessions = request.result;
      // Load events for each session
      for (const session of sessions) {
        session.events = await loadEventsForSession(session.id);
      }
      resolve(sessions);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getSession(id: string): Promise<SessionData | null> {
  const db = await openDB();
  return new Promise(async (resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readonly');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.get(id);

    request.onsuccess = async () => {
      const session = request.result;
      if (session) {
        session.events = await loadEventsForSession(session.id);
      }
      resolve(session || null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([SESSIONS_STORE, EVENTS_STORE, CHUNKS_STORE], 'readwrite');

  // Delete session
  const sessionStore = transaction.objectStore(SESSIONS_STORE);
  sessionStore.delete(id);

  // Delete associated events
  const eventsStore = transaction.objectStore(EVENTS_STORE);
  const eventsIndex = eventsStore.index('sessionId');
  const eventsRequest = eventsIndex.openCursor(IDBKeyRange.only(id));

  eventsRequest.onsuccess = (event) => {
    const cursor = (event.target as IDBRequest).result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  // Delete chunks
  const chunksStore = transaction.objectStore(CHUNKS_STORE);
  const chunksIndex = chunksStore.index('sessionId');
  const chunksRequest = chunksIndex.openCursor(IDBKeyRange.only(id));

  chunksRequest.onsuccess = (event) => {
    const cursor = (event.target as IDBRequest).result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Event operations
async function saveEvents(events: RecordedEvent[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENTS_STORE, 'readwrite');
    const store = transaction.objectStore(EVENTS_STORE);

    let completed = 0;
    const total = events.length;

    events.forEach(event => {
      const compressedEvent = compressEvent(event);
      const request = store.put(compressedEvent);

      request.onsuccess = () => {
        completed++;
        if (completed === total) resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function saveEventsInChunks(sessionId: string, events: RecordedEvent[]): Promise<void> {
  const db = await openDB();
  const chunks: EventChunk[] = [];

  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunkEvents = events.slice(i, i + CHUNK_SIZE);
    const compressedEvents = chunkEvents.map(compressEvent);

    chunks.push({
      id: `${sessionId}-chunk-${Math.floor(i / CHUNK_SIZE)}`,
      sessionId,
      chunkId: Math.floor(i / CHUNK_SIZE),
      events: compressedEvents,
      compressed: true
    });
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNKS_STORE, 'readwrite');
    const store = transaction.objectStore(CHUNKS_STORE);

    let completed = 0;
    const total = chunks.length;

    chunks.forEach(chunk => {
      const request = store.put(chunk);

      request.onsuccess = () => {
        completed++;
        if (completed === total) resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function loadEventsForSession(sessionId: string): Promise<RecordedEvent[]> {
  const db = await openDB();

  // Check if session uses chunks
  const chunks = await getChunksForSession(sessionId);
  if (chunks.length > 0) {
    const events: RecordedEvent[] = [];
    chunks.sort((a, b) => a.chunkId - b.chunkId);
    for (const chunk of chunks) {
      events.push(...chunk.events.map(decompressEvent));
    }
    return events;
  }

  // Load from events store
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENTS_STORE, 'readonly');
    const store = transaction.objectStore(EVENTS_STORE);
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);

    request.onsuccess = () => {
      resolve(request.result.map(decompressEvent));
    };
    request.onerror = () => reject(request.error);
  });
}

async function getChunksForSession(sessionId: string): Promise<EventChunk[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNKS_STORE, 'readonly');
    const store = transaction.objectStore(CHUNKS_STORE);
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Compression utilities
function compressEvent(event: RecordedEvent): RecordedEvent {
  // Simple compression: stringify large payloads
  const compressed = { ...event };

  if (JSON.stringify(event.payload).length > COMPRESSION_THRESHOLD) {
    // For large payloads, could implement more sophisticated compression
    // For now, just keep as is
  }

  return compressed;
}

function decompressEvent(event: RecordedEvent): RecordedEvent {
  // Decompression logic if needed
  return event;
}

// Delta encoding for DOM mutations (future enhancement)
export function createDeltaMutation(previousState: string, currentState: string): string {
  // Simple diff - in production, use proper diff algorithm
  return currentState; // Placeholder
}

export function applyDeltaMutation(baseState: string, delta: string): string {
  return delta; // Placeholder
}
