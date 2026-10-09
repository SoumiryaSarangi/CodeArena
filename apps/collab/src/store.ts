/**
 * Where a room's document lives between sessions (SD-§11.2, FR-PAD-06). The collab server asks for the stored state when
 * a document is first opened and hands the whole state back (debounced) while people edit and when the last one leaves.
 */
export interface DocStore {
  /** The stored Yjs state of the room, or null when nothing was stored yet. */
  fetch(roomId: string): Promise<Uint8Array | null>;
  /** Replaces the stored state. Must not throw for a room that no longer exists. */
  store(roomId: string, state: Uint8Array): Promise<void>;
}

/** Test double: keeps states in a map and counts the stores. */
export class MemoryStore implements DocStore {
  readonly states = new Map<string, Uint8Array>();
  stores = 0;
  fail = false;

  async fetch(roomId: string) {
    return this.states.get(roomId) ?? null;
  }

  async store(roomId: string, state: Uint8Array) {
    if (this.fail) throw new Error('store failed');
    this.stores++;
    this.states.set(roomId, new Uint8Array(state));
  }
}
