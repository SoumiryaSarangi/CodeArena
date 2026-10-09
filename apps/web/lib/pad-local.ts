import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

/**
 * CP-09 (FR-PAD-14, US-10.8): a copy of the room's document in this browser's IndexedDB. Edits made while the connection to
 * the room is down are kept here, survive a reload or a crashed tab, and merge into the room when the connection returns
 * (Yjs merges any two histories, so nothing is overwritten and nothing needs to be chosen). It is the person's own copy of
 * the code of a room they were in; it is removed when the room ends.
 */
export const padStoreName = (roomId: string) => `codearena-pad:${roomId}`;

export interface LocalPad {
  /** Resolves when what was stored has been loaded into the document (never rejects; also when storage is unavailable). */
  ready: Promise<void>;
  /** Resolves true once the database is open and a copy is really being kept; false in private windows or when refused. */
  saved: Promise<boolean>;
  destroy: () => void;
}

const NOTHING: LocalPad = { ready: Promise.resolve(), saved: Promise.resolve(false), destroy() {} };

/**
 * Whether the browser lets us open a database at all. Asked first because the library leaves an unhandled rejection
 * behind when it cannot (a private window, blocked site data). A separate name: opening the room's own name here would
 * create it empty, without the object stores the library sets up.
 */
function storageWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('codearena-probe');
      req.onsuccess = () => {
        req.result.close();
        resolve(true);
      };
      req.onerror = req.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Starts keeping `doc` in IndexedDB. A browser without usable storage gets a no-op, and the pad works as before. */
export function openLocalPad(doc: Y.Doc, roomId: string): LocalPad {
  if (typeof indexedDB === 'undefined') return NOTHING;
  let persistence: IndexeddbPersistence | null = null;
  let destroyed = false;
  const started = storageWorks().then((ok) => {
    if (!ok || destroyed) return null;
    persistence = new IndexeddbPersistence(padStoreName(roomId), doc);
    return persistence;
  });
  return {
    ready: Promise.race([
      started.then((p) => p?.whenSynced.then(() => undefined)),
      // a database that never opens (blocked by the browser) must not keep the pad from showing
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]).catch(() => undefined),
    saved: started.then(
      (p) => p !== null,
      () => false,
    ),
    destroy: () => {
      destroyed = true;
      void persistence?.destroy().catch(() => undefined);
    },
  };
}

/** Removes the local copy of a room (it ended, so the code is no longer wanted on this device). Never throws. */
export function clearLocalPad(roomId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(padStoreName(roomId));
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
