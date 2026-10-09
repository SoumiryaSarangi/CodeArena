import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, infrastructureUp } from './harness';
import { SERVICE_TOKEN, pause, until } from './test-support';

const ready = await infrastructureUp();

describe.skipIf(!ready)(
  'FR-PAD-12: restoring a snapshot is an anti-operation, everyone converges (needs Compose Postgres + Redis)',
  () => {
    let h: Awaited<ReturnType<typeof createHarness>>;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h.close();
    });

    const restore = (
      inst: { collab: { httpURL: string } },
      roomId: string,
      body: unknown,
      token: string | null = SERVICE_TOKEN,
    ) =>
      fetch(`${inst.collab.httpURL}/internal/rooms/${roomId}/restore`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-service-token': token } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    it('FR-PAD-12: restoring while another client types converges for everyone and loses none of their characters', async () => {
      for (let round = 0; round < 4; round++) {
        const inst = await h.startInstance();
        const room = await h.makeRoom();
        const interviewer = await h.join(inst, room, h.identity('interviewer', 'ivy'));
        const typist = await h.join(inst, room, h.identity('candidate', 'asha'));
        const target = 'int main() {\n  return 0;\n}\n';
        interviewer.text.insert(0, target);
        await until(() => typist.text.toString() === target);
        // the candidate rewrites the code, so there is something to undo
        typist.text.delete(0, typist.text.length);
        typist.text.insert(0, 'print("hello")\nprint("world")\n');
        await until(() => interviewer.text.toString().startsWith('print'));

        let typed = 0;
        let typedAfter = 0;
        let restored = false;
        const typing = (async () => {
          for (let i = 0; i < 40; i++) {
            const at = Math.floor(Math.random() * (typist.text.length + 1));
            typist.text.insert(at, '§');
            typed++;
            if (restored) typedAfter++;
            await pause(8);
          }
        })();
        await pause(60);
        const res = await restore(inst, room, {
          text: target,
          language: 'cpp17',
          userId: interviewer.who.userId,
        });
        restored = true;
        expect(res.status).toBe(200);
        await typing;

        await until(
          () =>
            interviewer.text.toString() === typist.text.toString() &&
            interviewer.text.toString().replaceAll('§', '') === target,
          10_000,
        );
        const final = typist.text.toString();
        // what was typed before the restore reached the server is undone with the rest; what came after is kept
        const kept = final.split('§').length - 1;
        expect(kept).toBeGreaterThanOrEqual(typedAfter);
        expect(kept).toBeLessThanOrEqual(typed);
        expect(final.replaceAll('§', '')).toBe(target);
        // the server's own copy agrees with both clients
        const late = await h.join(inst, room);
        await until(() => late.text.toString() === final);
        await inst.stop();
      }
    }, 60_000);

    it('FR-PAD-12: what survives keeps its place, so a restore is an edit and not a replacement', async () => {
      const inst = await h.startInstance();
      const room = await h.makeRoom();
      const a = await h.join(inst, room, h.identity('interviewer', 'ivy'));
      const b = await h.join(inst, room, h.identity('candidate', 'asha'));
      a.text.insert(0, 'int main() {}');
      await until(() => b.text.toString() === 'int main() {}');
      b.text.insert(13, ' // later junk');
      await until(() => a.text.toString().endsWith('junk'));
      const mark = Y.createRelativePositionFromTypeIndex(b.text, 4); // the "m" of main
      const res = await restore(inst, room, {
        text: 'int main() {}',
        language: 'cpp17',
        userId: a.who.userId,
      });
      expect(res.status).toBe(200);
      await until(() => b.text.toString() === 'int main() {}');
      const abs = Y.createAbsolutePositionFromRelativePosition(mark, b.doc);
      expect(abs?.index).toBe(4);
      await inst.stop();
    });

    it('FR-PAD-12: the language comes back with the code, and the log credits the interviewer', async () => {
      const inst = await h.startInstance();
      const room = await h.makeRoom();
      const ivy = await h.join(inst, room, h.identity('interviewer', 'ivy'));
      ivy.text.insert(0, 'old');
      ivy.meta.set('language', 'python3');
      const asha = await h.join(inst, room, h.identity('candidate', 'asha'));
      await until(() => asha.text.toString() === 'old');
      asha.text.insert(3, ' and new');
      asha.meta.set('language', 'java21');
      await until(() => ivy.meta.get('language') === 'java21');

      const res = await restore(inst, room, {
        text: 'old',
        language: 'python3',
        userId: ivy.who.userId,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { edits: number }).edits).toBe(1);
      await until(() => asha.text.toString() === 'old' && asha.meta.get('language') === 'python3');
      await inst.log.flush();
      const ev = await h.sql.query(
        `select user_id, payload from room_events where room_id=$1 and kind='language' order by seq desc limit 1`,
        [room],
      );
      expect(ev.rows[0].user_id).toBe(ivy.who.userId);
      expect(ev.rows[0].payload).toEqual({ language: 'python3' });
      const up = await h.sql.query(
        `select user_id from room_updates where room_id=$1 order by seq desc limit 1`,
        [room],
      );
      expect(up.rows[0].user_id).toBe(ivy.who.userId);
      await inst.stop();
    });

    it('FR-PAD-12: with nobody connected the stored document is changed and the next person sees it', async () => {
      const inst = await h.startInstance();
      const room = await h.makeRoom();
      const a = await h.join(inst, room);
      a.text.insert(0, 'before the restore');
      await pause(400);
      a.leave();
      await pause(400);
      const res = await restore(inst, room, {
        text: 'after',
        language: 'node',
        userId: randomUUID(),
      });
      expect(res.status).toBe(200);
      const b = await h.join(inst, room);
      await until(() => b.text.toString() === 'after');
      expect(b.meta.get('language')).toBe('node');
      await inst.stop();
    });

    it('FR-PAD-12: asking one of two instances reaches clients on the other, exactly once', async () => {
      const one = await h.startInstance({ redis: true });
      const two = await h.startInstance({ redis: true });
      const room = await h.makeRoom();
      const onOne = await h.join(one, room);
      const onTwo = await h.join(two, room);
      onOne.text.insert(0, 'abc');
      await until(() => onTwo.text.toString() === 'abc');
      onTwo.text.insert(3, 'def');
      await until(() => onOne.text.toString() === 'abcdef');
      const res = await restore(two, room, {
        text: 'abc',
        language: 'cpp17',
        userId: randomUUID(),
      });
      expect(res.status).toBe(200);
      await until(() => onOne.text.toString() === 'abc' && onTwo.text.toString() === 'abc');
      await pause(500);
      expect(onOne.text.toString()).toBe('abc');
      expect(onTwo.text.toString()).toBe('abc');
      await one.stop();
      await two.stop();
    }, 30_000);

    it('FR-PAD-12: only the API may ask, and only with a well-formed body', async () => {
      const inst = await h.startInstance();
      const room = await h.makeRoom();
      const ok = { text: 'x', language: 'cpp17', userId: randomUUID() };
      expect((await restore(inst, room, ok, null)).status).toBe(401);
      expect((await restore(inst, room, ok, 'wrong'.repeat(8))).status).toBe(401);
      expect((await restore(inst, room, 'not json')).status).toBe(400);
      expect((await restore(inst, room, { ...ok, extra: 1 })).status).toBe(400);
      expect((await restore(inst, room, { ...ok, userId: 'nope' })).status).toBe(400);
      expect(
        (
          await restore(inst, room, {
            text: 'y'.repeat(300 * 1024),
            language: 'c',
            userId: ok.userId,
          })
        ).status,
      ).toBe(400);
      expect((await restore(inst, room, 'z'.repeat(500 * 1024))).status).toBe(413);
      await inst.stop();
    });
  },
);
