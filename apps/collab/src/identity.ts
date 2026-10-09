import { PRESENCE_COLOURS, type CollabIdentity } from '@codearena/contracts';

/** One Y.Doc per room, named `room:{roomId}` (SD-§11.1). */
const ROOM_DOC = /^room:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function roomIdOf(documentName: string): string | null {
  return ROOM_DOC.exec(documentName)?.[1] ?? null;
}

/** What peers see of a person: only values the server verified. The colour is an index into the UI palette. */
export const presenceUser = (who: Pick<CollabIdentity, 'name' | 'role' | 'colorIndex'>) => ({
  name: who.name,
  role: who.role,
  colorIndex: who.colorIndex % PRESENCE_COLOURS,
});

/** An awareness state bigger than this is dropped: it is a cursor and a name, not a place to store things. */
export const MAX_AWARENESS_BYTES = 4096;

type State = Record<string, unknown> | null;

/**
 * Who may speak for which awareness client id. The first connection to write an id owns it until that connection goes
 * away; another connection that writes the same id (to rename a peer, or to remove them) is ignored. Without this a
 * contestant-grade attacker could erase or impersonate the interviewer's cursor.
 */
export class AwarenessOwners {
  private readonly owners = new Map<string, Map<number, string>>();

  /** True if `socketId` owns (or now takes) `clientId` in this document. */
  claim(documentName: string, clientId: number, socketId: string): boolean {
    let doc = this.owners.get(documentName);
    if (!doc) this.owners.set(documentName, (doc = new Map()));
    const owner = doc.get(clientId);
    if (owner === undefined) {
      doc.set(clientId, socketId);
      return true;
    }
    return owner === socketId;
  }

  release(documentName: string, socketId: string): void {
    const doc = this.owners.get(documentName);
    if (!doc) return;
    for (const [id, owner] of doc) if (owner === socketId) doc.delete(id);
    if (doc.size === 0) this.owners.delete(documentName);
  }
}

/**
 * FR-PAD-04: rewrites an inbound awareness update in place. Every state a connection sends gets its `user` replaced with
 * the verified identity (cursor and selection stay), states for ids the connection does not own are dropped, and
 * oversized states are dropped. Returns how many states were changed or removed (for the metric).
 */
export function rewriteAwareness(
  states: Map<number, State>,
  who: Pick<CollabIdentity, 'name' | 'role' | 'colorIndex'>,
  documentName: string,
  socketId: string,
  owners: AwarenessOwners,
): { rewritten: number; dropped: number } {
  let rewritten = 0;
  let dropped = 0;
  for (const [clientId, state] of [...states]) {
    if (!owners.claim(documentName, clientId, socketId)) {
      states.delete(clientId);
      dropped++;
      continue;
    }
    if (state === null || typeof state !== 'object') continue; // the owner removing their own presence
    if (JSON.stringify(state).length > MAX_AWARENESS_BYTES) {
      states.delete(clientId);
      dropped++;
      continue;
    }
    state.user = presenceUser(who);
    rewritten++;
  }
  return { rewritten, dropped };
}
