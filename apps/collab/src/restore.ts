import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { diffText } from './text-diff';

/** The shared code and its language live in these two places of the document (see `apps/web/lib/rooms`). */
export const CODE_KEY = 'code';
export const META_KEY = 'meta';

/**
 * CP-07 (FR-PAD-12): put a snapshot's code back as an anti-operation. The live `Y.Text` is edited, in one transaction,
 * until it reads like the snapshot: what is only in the present is deleted, what was only in the past is inserted.
 * Anyone typing at the same time keeps their characters and every client converges, which replacing the state would
 * not give. Returns how many edits it took (0 when the code already matched).
 */
export async function restoreSnapshot(
  hocuspocus: Hocuspocus,
  roomId: string,
  snapshot: { text: string; language: string },
  context: Record<string, unknown>,
): Promise<number> {
  const conn = await hocuspocus.openDirectConnection(`room:${roomId}`, context);
  let edits = 0;
  try {
    await conn.transact((doc) => {
      const text = doc.getText(CODE_KEY);
      const list = diffText(text.toString(), snapshot.text);
      edits = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]!;
        if (e.delete) text.delete(e.index, e.delete);
        if (e.insert) text.insert(e.index, e.insert);
      }
      const meta: Y.Map<unknown> = doc.getMap(META_KEY);
      if (meta.get('language') !== snapshot.language) meta.set('language', snapshot.language);
    });
  } finally {
    await conn.disconnect();
  }
  return edits;
}
