import type { SessionResponse } from '@pb/schema';
/**
 * F1 local session storage in IndexedDB, so results can be inspected (admin → Sesi tersimpan).
 * F3 replaces this with the agent (SQLite + disk + upload queue). Nothing is deleted automatically:
 * files may only be removed after a confirmed upload (CLAUDE.md invariant).
 */

export type StoredShot = {
  photoId: string;
  slotIndex: number;
  takeNumber: number;
  /** Selected take for the slot (session_shots.selected). */
  selected: boolean;
  width: number;
  height: number;
  mimeType: string;
  /** ISO 8601, UTC. */
  capturedAt: string;
};

export type StoredSession = {
  id: string;
  code: string;
  boothId: string;
  configVersion: number;
  frameId: string | null;
  filterId: string;
  paymentMethod: string | null;
  amount: number;
  extraPrints: number;
  /** Consent + survey answers (F8); absent in sessions saved before F8. */
  responses?: SessionResponse[];
  downloadUrl: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  savedAt: string;
  shots: StoredShot[];
};

type PhotoRow = { id: string; sessionId: string; blob: Blob };

const DB_NAME = 'pb-kiosk';
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function saveSession(
  session: StoredSession,
  photos: { id: string; blob: Blob }[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'photos'], 'readwrite');
  tx.objectStore('sessions').put(session);
  const store = tx.objectStore('photos');
  for (const p of photos)
    store.put({ id: p.id, sessionId: session.id, blob: p.blob } satisfies PhotoRow);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Newest first. */
export async function listSessions(limit = 50): Promise<StoredSession[]> {
  const db = await openDb();
  const all = await request<StoredSession[]>(
    db.transaction('sessions').objectStore('sessions').getAll(),
  );
  return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, limit);
}

export async function getSessionPhotos(sessionId: string): Promise<Map<string, Blob>> {
  const db = await openDb();
  const rows = await request<PhotoRow[]>(
    db.transaction('photos').objectStore('photos').index('sessionId').getAll(sessionId),
  );
  return new Map(rows.map((r) => [r.id, r.blob]));
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
