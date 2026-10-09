import * as Y from 'yjs';

/** The close code for a connection whose change would take the document past the cap (application range). */
export const CLOSE_DOC_TOO_LARGE = { code: 4413, reason: 'document-too-large' } as const;

const readVarUint = (buf: Uint8Array, at: number): [number, number] => {
  let n = 0;
  let shift = 0;
  for (let i = at; i < buf.length; i++) {
    const b = buf[i]!;
    n += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [n, i + 1];
    shift += 7;
  }
  return [0, buf.length];
};

/**
 * The Yjs update inside a Hocuspocus message `[varString documentName][varUint type=0 sync][varUint 1|2][varUint8Array]`,
 * or null for anything else (awareness, queries, sync step 1).
 */
export function syncUpdateOf(raw: Uint8Array): Uint8Array | null {
  const [nameLen, afterName] = readVarUint(raw, 0);
  const [type, afterType] = readVarUint(raw, afterName + nameLen);
  if (type !== 0) return null;
  const [sub, afterSub] = readVarUint(raw, afterType);
  if (sub !== 1 && sub !== 2) return null;
  const [len, at] = readVarUint(raw, afterSub);
  return at + len <= raw.length ? raw.subarray(at, at + len) : null;
}

/** True if the update only deletes: it carries no new structs (inserted content). Anything unreadable counts as adding. */
export function addsNoContent(update: Uint8Array): boolean {
  try {
    return Y.decodeUpdate(update).structs.length === 0;
  } catch {
    return false;
  }
}

/**
 * CP-07 (FR-PAD-13): the shared document may not grow past `max` bytes of Yjs state. A running estimate (state size when
 * first seen plus every update since) keeps ordinary typing free; only near the cap is the real size worked out, by
 * applying the update to a copy. A change that would pass the cap is refused, one that shrinks the document is not, so
 * a full pad can always be cleaned up.
 */
export class DocSizeGuard {
  private readonly estimate = new WeakMap<Y.Doc, number>();

  constructor(readonly max: number) {}

  /** True if the message may be applied. */
  allows(doc: Y.Doc, raw: Uint8Array): boolean {
    const update = syncUpdateOf(raw);
    if (!update) return true;
    // An update with nothing to insert (only deletions) adds no content, only a few bytes of delete-set bookkeeping.
    // Clearing a full pad must always work, so it is never refused, even when those bytes would tip the state over the cap.
    if (addsNoContent(update)) return true;
    const known = this.estimate.get(doc);
    if (known !== undefined && known + update.length <= this.max) {
      this.estimate.set(doc, known + update.length);
      return true;
    }
    const state = Y.encodeStateAsUpdate(doc);
    if (state.length + update.length <= this.max) {
      this.estimate.set(doc, state.length + update.length);
      return true;
    }
    const copy = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(copy, state);
      Y.applyUpdate(copy, update);
      const size = Y.encodeStateAsUpdate(copy).length;
      this.estimate.set(doc, size <= this.max ? size : state.length);
      return size <= this.max;
    } catch {
      return true; // not a valid update: the server's own handling rejects it
    } finally {
      copy.destroy();
    }
  }
}
