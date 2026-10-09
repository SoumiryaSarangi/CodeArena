import { describe, expect, it } from 'vitest';
import {
  AwarenessOwners,
  MAX_AWARENESS_BYTES,
  presenceUser,
  rewriteAwareness,
  roomIdOf,
} from './identity';

const who = { name: 'asha', role: 'candidate', colorIndex: 3 } as const;
const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('FR-PAD-03: document names', () => {
  it('only room:{uuid} is a room', () => {
    expect(roomIdOf(`room:${ID}`)).toBe(ID);
    for (const bad of [
      '',
      'room:',
      'room:abc',
      `Room:${ID}`,
      `room:${ID}x`,
      `room:${ID}/../x`,
      ID,
      `lobby`,
      `room:${ID.toUpperCase()}`,
    ]) {
      expect(roomIdOf(bad), bad).toBeNull();
    }
  });
});

describe('FR-PAD-04: awareness rewriting', () => {
  it('presence carries only verified fields, and the colour index stays inside the palette', () => {
    expect(presenceUser({ ...who, colorIndex: 11 })).toEqual({
      name: 'asha',
      role: 'candidate',
      colorIndex: 3,
    });
  });

  it('replaces `user` in every state a connection owns and keeps the other fields', () => {
    const owners = new AwarenessOwners();
    const states = new Map<number, Record<string, unknown> | null>([
      [1, { user: { name: 'Admin' }, cursor: { anchor: 1 } }],
    ]);
    expect(rewriteAwareness(states, who, 'room:a', 's1', owners)).toEqual({
      rewritten: 1,
      dropped: 0,
    });
    expect(states.get(1)).toEqual({
      user: { name: 'asha', role: 'candidate', colorIndex: 3 },
      cursor: { anchor: 1 },
    });
  });

  it('a state without a user gets one; removing your own presence passes through', () => {
    const owners = new AwarenessOwners();
    const states = new Map<number, Record<string, unknown> | null>([[7, { cursor: 1 }]]);
    rewriteAwareness(states, who, 'room:a', 's1', owners);
    expect(states.get(7)!.user).toBeDefined();
    const gone = new Map<number, Record<string, unknown> | null>([[7, null]]);
    expect(rewriteAwareness(gone, who, 'room:a', 's1', owners)).toEqual({
      rewritten: 0,
      dropped: 0,
    });
    expect(gone.has(7)).toBe(true);
  });

  it('ids owned by another connection are dropped, in the same document only, and free up on disconnect', () => {
    const owners = new AwarenessOwners();
    rewriteAwareness(new Map([[5, { cursor: 1 }]]), who, 'room:a', 's1', owners);
    const attack = new Map<number, Record<string, unknown> | null>([
      [5, { user: { name: 'x' } }],
      [6, null],
    ]);
    expect(rewriteAwareness(attack, who, 'room:a', 's2', owners)).toMatchObject({ dropped: 1 });
    expect(attack.has(5)).toBe(false);
    expect(attack.has(6)).toBe(true); // s2 takes a fresh id
    const sameIdOtherRoom = new Map<number, Record<string, unknown> | null>([[5, { cursor: 2 }]]);
    expect(rewriteAwareness(sameIdOtherRoom, who, 'room:b', 's2', owners).dropped).toBe(0);
    owners.release('room:a', 's1');
    const after = new Map<number, Record<string, unknown> | null>([[5, { cursor: 3 }]]);
    expect(rewriteAwareness(after, who, 'room:a', 's2', owners).dropped).toBe(0);
  });

  it('drops a state over the size limit', () => {
    const owners = new AwarenessOwners();
    const big = new Map<number, Record<string, unknown> | null>([
      [1, { blob: 'z'.repeat(MAX_AWARENESS_BYTES) }],
    ]);
    expect(rewriteAwareness(big, who, 'room:a', 's1', owners)).toEqual({
      rewritten: 0,
      dropped: 1,
    });
    expect(big.size).toBe(0);
  });
});
