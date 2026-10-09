import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { clearLocalPad, openLocalPad, padStoreName } from '@/lib/pad-local';

afterEach(() => vi.unstubAllGlobals());

describe('FR-PAD-14: the local copy of a room never keeps the pad from working', () => {
  it('FR-PAD-14: one database per room, named after it', () => {
    expect(padStoreName('abc')).toBe('codearena-pad:abc');
    expect(padStoreName('abc')).not.toBe(padStoreName('abd'));
  });

  it('FR-PAD-14: without IndexedDB (a private window, an old browser) the pad opens as before and says nothing is kept', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const doc = new Y.Doc();
    const local = openLocalPad(doc, 'room-1');
    await expect(local.ready).resolves.toBeUndefined();
    await expect(local.saved).resolves.toBe(false);
    local.destroy(); // nothing to do, and no error
    await expect(clearLocalPad('room-1')).resolves.toBeUndefined();
    // the document itself is untouched and usable
    doc.getText('code').insert(0, 'still works');
    expect(doc.getText('code').toString()).toBe('still works');
  });

  it('FR-PAD-14: a browser that refuses to open the database is treated the same way', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('SecurityError');
      },
      deleteDatabase: () => {
        throw new Error('SecurityError');
      },
    });
    const local = openLocalPad(new Y.Doc(), 'room-2');
    await expect(local.ready).resolves.toBeUndefined();
    await expect(local.saved).resolves.toBe(false);
    await expect(clearLocalPad('room-2')).resolves.toBeUndefined(); // clearing never throws either
  });

  it('FR-PAD-14: clearing resolves even if deletion is blocked by an open connection or fails', async () => {
    for (const event of ['onblocked', 'onerror', 'onsuccess'] as const) {
      vi.stubGlobal('indexedDB', {
        deleteDatabase: () => {
          const req: Record<string, (() => void) | undefined> = {};
          queueMicrotask(() => req[event]?.());
          return req;
        },
      });
      await expect(clearLocalPad('room-3')).resolves.toBeUndefined();
    }
  });
});
