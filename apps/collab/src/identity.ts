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
 * Where a claim on an awareness client id is recorded beyond this process. With several collab instances a claim has to
 * be shared, or an attacker on instance B could take the id of someone on instance A (FR-PAD-04).
 */
export interface ClaimBackend {
  /** True if `socketId` holds this id afterwards (it took it, or already had it); false if someone else holds it. */
  claim(documentName: string, clientId: number, socketId: string): Promise<boolean>;
  release(documentName: string, clientId: number, socketId: string): Promise<void>;
  /** Keeps live claims alive; claims of a dead instance expire by themselves. */
  refresh?(claims: { documentName: string; clientId: number; socketId: string }[]): Promise<void>;
}

/**
 * Who may speak for which awareness client id. The first connection to write an id owns it until that connection goes
 * away; another connection that writes the same id (to rename a peer, or to remove them) is ignored. Without this a
 * contestant-grade attacker could erase or impersonate the interviewer's cursor. A local map answers the common case;
 * the optional backend makes the claim hold across instances. If the backend cannot be reached the claim is refused:
 * presence may be lost for a moment, it is never taken over.
 */
export class AwarenessOwners {
  private readonly owners = new Map<string, Map<number, string>>();

  constructor(private readonly backend?: ClaimBackend) {}

  /** True if `socketId` owns (or now takes) `clientId` in this document. */
  async claim(documentName: string, clientId: number, socketId: string): Promise<boolean> {
    let doc = this.owners.get(documentName);
    const owner = doc?.get(clientId);
    if (owner !== undefined) return owner === socketId;
    if (this.backend) {
      try {
        if (!(await this.backend.claim(documentName, clientId, socketId))) return false;
      } catch {
        return false;
      }
    }
    // Another update of the same connection may have claimed it while we waited.
    doc = this.owners.get(documentName);
    if (!doc) this.owners.set(documentName, (doc = new Map()));
    const now = doc.get(clientId);
    if (now !== undefined && now !== socketId) return false;
    doc.set(clientId, socketId);
    return true;
  }

  async release(documentName: string, socketId: string): Promise<void> {
    const doc = this.owners.get(documentName);
    if (!doc) return;
    for (const [id, owner] of [...doc]) {
      if (owner !== socketId) continue;
      doc.delete(id);
      await this.backend?.release(documentName, id, socketId).catch(() => undefined);
    }
    if (doc.size === 0) this.owners.delete(documentName);
  }

  /** Everything this process currently owns, for the refresh timer. */
  claims(): { documentName: string; clientId: number; socketId: string }[] {
    return [...this.owners].flatMap(([documentName, doc]) =>
      [...doc].map(([clientId, socketId]) => ({ documentName, clientId, socketId })),
    );
  }

  async refresh(): Promise<void> {
    await this.backend?.refresh?.(this.claims()).catch(() => undefined);
  }
}

/**
 * FR-PAD-04: rewrites an inbound awareness update in place. Every state a connection sends gets its `user` replaced with
 * the verified identity (cursor and selection stay), states for ids the connection does not own are dropped, and
 * oversized states are dropped. Returns how many states were changed or removed (for the metric).
 */
export async function rewriteAwareness(
  states: Map<number, State>,
  who: Pick<CollabIdentity, 'name' | 'role' | 'colorIndex'>,
  documentName: string,
  socketId: string,
  owners: AwarenessOwners,
): Promise<{ rewritten: number; dropped: number }> {
  let rewritten = 0;
  let dropped = 0;
  for (const [clientId, state] of [...states]) {
    if (!(await owners.claim(documentName, clientId, socketId))) {
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
