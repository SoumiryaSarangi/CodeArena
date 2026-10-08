import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { auditLog, contests, problemVersions, problems, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});
const s3Up = await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_TESTS })).then(
  () => true,
  () => false,
);
const probe = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
probe.on('error', () => {});
const redisUp = await probe.connect().then(
  () => true,
  () => false,
);
probe.disconnect();
const ready = s3Up && redisUp && (await postgresReachable());

const prefix = `t${randomBytes(4).toString('hex')}:`;
const csrf = randomBytes(32).toString('base64url');
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1, P2] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 2) as [string, string];
const MIN = 60_000;

describe.skipIf(!ready)(
  'C-05: clarifications and announcements (needs the Compose Postgres, Redis and S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let redis: Redis;
    let tokens: AccessTokens;
    let admin: { id: string; token: string };
    let c: { id: string; slug: string };

    const makeUser = async (role: 'user' | 'setter' | 'admin' = 'user') => {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: `${id}@example.test`,
        role,
        handle: `m${id.slice(0, 8)}`,
      });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token };
    };
    const call = (
      method: 'get' | 'post' | 'put' | 'patch',
      path: string,
      token?: string,
      body?: unknown,
    ) => {
      const r = request(app.getHttpServer())[method](`/api${path}`);
      if (token) r.set('Authorization', `Bearer ${token}`);
      r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body as object);
    };
    const times = (startIn: number, endIn: number) =>
      db
        .update(contests)
        .set({ startsAt: new Date(Date.now() + startIn), endsAt: new Date(Date.now() + endIn) })
        .where(eq(contests.id, c.id));
    const registered = async () => {
      const u = await makeUser();
      expect((await call('post', `/contests/${c.slug}/register`, u.token)).status).toBe(201);
      return u;
    };
    /** Records everything published on the channels of this contest. */
    const listen = async () => {
      const sub = new Redis(config.REDIS_URL);
      const got: { topic: string; type: string; data: Record<string, unknown> }[] = [];
      await sub.psubscribe(`${prefix}rt:*${c.id}*`);
      sub.on('pmessage', (_p, _ch, msg) => {
        const { envelope } = JSON.parse(msg) as {
          envelope: { topic: string; type: string; data: Record<string, unknown> };
        };
        got.push(envelope);
      });
      return { got, stop: () => sub.disconnect() };
    };
    const settle = () => new Promise((r) => setTimeout(r, 250));

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      const cfg = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_DEFAULT_PER_MIN: '100000',
        DATABASE_URL: t.url,
        QUEUE_KEY_PREFIX: prefix,
      });
      redis = new Redis(cfg.REDIS_URL);
      app = await createApp(cfg);
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      const importer = app.get(ProblemImporter);
      for (const slug of [P1, P2]) {
        const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
        if (!r.ok) throw new Error(`${slug} rejected`);
        await importer.import(r.pkg, { visibility: 'contest' });
        await db
          .update(problemVersions)
          .set({ validationStatus: 'passed' })
          .where(
            eq(
              problemVersions.problemId,
              (
                await db.select({ id: problems.id }).from(problems).where(eq(problems.slug, slug))
              )[0]!.id,
            ),
          );
      }
      admin = await makeUser('admin');
      const slug = `m-${prefix.slice(0, -1)}`;
      const made = await call('post', '/admin/contests', admin.token, {
        slug,
        title: 'Messages',
        startsAt: new Date(Date.now() + 60 * MIN).toISOString(),
        endsAt: new Date(Date.now() + 180 * MIN).toISOString(),
      });
      c = { id: made.body.id, slug };
      await call('put', `/admin/contests/${c.id}/problems`, admin.token, {
        items: [
          { label: 'A', slug: P1 },
          { label: 'B', slug: P2 },
        ],
      });
      expect(
        (await call('patch', `/admin/contests/${c.id}`, admin.token, { published: true })).status,
      ).toBe(200);
    });

    afterAll(async () => {
      await app?.close();
      const keys = redis ? await redis.keys(`${prefix}*`) : [];
      if (keys.length) await redis.del(...keys);
      redis?.disconnect();
      await drop?.();
    });

    const ask = (token: string | undefined, body: object) =>
      call('post', `/contests/${c.slug}/clarifications`, token, body);

    it('FR-CONT-04: questions need a running contest, registration and a real problem', async () => {
      const u = await registered();
      const v = await registered(); // asks only after the end (the limit is 6 questions a minute)
      const early = await ask(u.token, { question: 'Can I use Python?' });
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('contest-not-started');
      await times(-MIN, 120 * MIN);
      expect((await ask(undefined, { question: 'x' })).status).toBe(401);
      const stranger = await makeUser();
      expect((await ask(stranger.token, { question: 'x' })).status).toBe(403);
      expect((await ask(u.token, { question: '   ' })).status).toBe(400);
      expect((await ask(u.token, { question: 'x'.repeat(2001) })).status).toBe(400);
      expect((await ask(u.token, { problemLabel: 'Q', question: 'Is Q real?' })).status).toBe(400);
      const ok = await ask(u.token, { problemLabel: 'A', question: 'Is n at least 1?' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body).toMatchObject({
        problemLabel: 'A',
        answer: null,
        mine: true,
        isPublic: false,
      });
      const general = await ask(u.token, { question: 'Is there a break?' });
      expect(general.body.problemLabel).toBeNull();
      await times(-120 * MIN, -MIN);
      const late = await ask(v.token, { question: 'too late' });
      expect(late.status).toBe(422);
      expect(late.body.code).toBe('contest-ended');
    });

    it('FR-CONT-04: I see my own questions and public answers, never someone else’s private ones', async () => {
      await times(-MIN, 120 * MIN);
      const a = await registered();
      const b = await registered();
      const qa = (await ask(a.token, { question: 'A private matter' })).body;
      const qb = (await ask(b.token, { problemLabel: 'B', question: 'Public interest?' })).body;
      // Unanswered questions of others are invisible.
      expect(
        (await call('get', `/contests/${c.slug}/clarifications`, a.token)).body.items.map(
          (i: { id: string }) => i.id,
        ),
      ).toEqual([qa.id]);
      // Roles: only admins answer.
      const setter = await makeUser('setter');
      const body = { answer: 'Yes.', isPublic: true };
      expect(
        (await call('post', `/admin/clarifications/${qb.id}/answer`, a.token, body)).status,
      ).toBe(403);
      expect(
        (await call('post', `/admin/clarifications/${qb.id}/answer`, setter.token, body)).status,
      ).toBe(403);
      expect(
        (await call('post', `/admin/clarifications/${qb.id}/answer`, undefined, body)).status,
      ).toBe(401);
      expect(
        (await call('post', `/admin/clarifications/${randomUUID()}/answer`, admin.token, body))
          .status,
      ).toBe(404);
      expect(
        (
          await call('post', `/admin/clarifications/${qb.id}/answer`, admin.token, {
            answer: '',
            isPublic: true,
          })
        ).status,
      ).toBe(400);
      // A public answer is visible to everyone registered, with its question.
      expect(
        (await call('post', `/admin/clarifications/${qb.id}/answer`, admin.token, body)).status,
      ).toBe(200);
      const aSees = (await call('get', `/contests/${c.slug}/clarifications`, a.token)).body.items;
      expect(aSees.map((i: { id: string }) => i.id).sort()).toEqual([qa.id, qb.id].sort());
      const pub = aSees.find((i: { id: string }) => i.id === qb.id);
      expect(pub).toMatchObject({ answer: 'Yes.', isPublic: true, mine: false, problemLabel: 'B' });
      expect(JSON.stringify(pub)).not.toContain(b.id);
      // A private answer reaches only its asker.
      expect(
        (
          await call('post', `/admin/clarifications/${qa.id}/answer`, admin.token, {
            answer: 'Not telling.',
            isPublic: false,
          })
        ).status,
      ).toBe(200);
      const aNow = (
        await call('get', `/contests/${c.slug}/clarifications`, a.token)
      ).body.items.find((i: { id: string }) => i.id === qa.id);
      expect(aNow).toMatchObject({ answer: 'Not telling.', isPublic: false, mine: true });
      expect(
        (await call('get', `/contests/${c.slug}/clarifications`, b.token)).body.items.map(
          (i: { id: string }) => i.id,
        ),
      ).toEqual([qb.id]);
      // Strangers and guests cannot list.
      const stranger = await makeUser();
      expect((await call('get', `/contests/${c.slug}/clarifications`, stranger.token)).status).toBe(
        403,
      );
      expect((await call('get', `/contests/${c.slug}/clarifications`)).status).toBe(401);
    });

    it('US-4.6: the admin inbox lists unanswered questions first, with the asker', async () => {
      await times(-MIN, 120 * MIN);
      const u = await registered();
      const q = (await ask(u.token, { question: 'Inbox question' })).body;
      expect((await call('get', `/admin/contests/${c.id}/clarifications`, u.token)).status).toBe(
        403,
      );
      const inbox = (await call('get', `/admin/contests/${c.id}/clarifications`, admin.token)).body
        .items;
      const firstAnswered = inbox.findIndex((i: { answer: string | null }) => i.answer !== null);
      const lastOpen = inbox
        .map((i: { answer: string | null }) => i.answer === null)
        .lastIndexOf(true);
      expect(lastOpen).toBeLessThan(firstAnswered === -1 ? Infinity : firstAnswered);
      expect(inbox.find((i: { id: string }) => i.id === q.id)).toMatchObject({
        askerId: u.id,
        askerHandle: expect.stringMatching(/^m/),
        answer: null,
      });
    });

    it('FR-CONT-04: pushed in real time to the right audience only', async () => {
      await times(-MIN, 120 * MIN);
      const a = await registered();
      const l = await listen();
      const q = (await ask(a.token, { problemLabel: 'A', question: 'Live question?' })).body;
      await call('post', `/admin/clarifications/${q.id}/answer`, admin.token, {
        answer: 'Just for you.',
        isPublic: false,
      });
      const q2 = (await ask(a.token, { question: 'Another?' })).body;
      await call('post', `/admin/clarifications/${q2.id}/answer`, admin.token, {
        answer: 'For all.',
        isPublic: true,
      });
      const sent = await call('post', `/admin/contests/${c.id}/announcements`, admin.token, {
        body: 'Lunch at one.',
      });
      expect(sent.status).toBe(201);
      await settle();
      l.stop();
      const by = (topic: string, type: string) =>
        l.got.filter((e) => e.topic === topic && e.type === type);
      // Admins hear new questions, with the asker.
      const news = by(`admin:contest:${c.id}:clar`, 'clar.new');
      expect(news).toHaveLength(2);
      expect((news[0]!.data.item as { askerId: string }).askerId).toBe(a.id);
      // The private answer goes to its asker's topic only.
      const priv = by(`contest:${c.id}:u:${a.id}`, 'clar.answer');
      expect(priv).toHaveLength(1);
      expect(priv[0]!.data.item).toMatchObject({ answer: 'Just for you.', mine: true });
      // The public answer and the announcement go to every contestant, naming nobody.
      const pub = by(`contest:${c.id}:clar`, 'clar.answer');
      expect(pub).toHaveLength(1);
      expect(pub[0]!.data.item).toMatchObject({ answer: 'For all.', isPublic: true });
      expect(JSON.stringify(l.got.filter((e) => e.topic === `contest:${c.id}:clar`))).not.toContain(
        a.id,
      );
      expect(JSON.stringify(l.got.filter((e) => e.topic === `contest:${c.id}:clar`))).not.toContain(
        'Just for you',
      );
      expect(by(`contest:${c.id}:clar`, 'announce.new')[0]!.data.item).toMatchObject({
        body: 'Lunch at one.',
      });
    });

    it('C-09: the organiser learns how many live streams an announcement reached', async () => {
      await times(-MIN, 120 * MIN);
      const u = await registered();
      const topic = `contest:${c.id}:clar`;
      const post = (text: string) =>
        call('post', `/admin/contests/${c.id}/announcements`, admin.token, { body: text });
      const before = await post('Nobody connected yet.');
      expect(before.body).toMatchObject({ reached: 0 });
      expect(before.body.registered).toBeGreaterThanOrEqual(1);

      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as { port: number };
      const t = (await call('post', '/realtime/ticket', u.token, { topics: [topic] })).body;
      const ctl = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/api/sse?ticket=${t.ticket}&topics=${encodeURIComponent(topic)}`,
        { signal: ctl.signal },
      );
      expect(res.status).toBe(200);
      await res.body!.getReader().read(); // the stream is open: `retry: 3000`
      await settle();
      expect((await post('One contestant is watching.')).body.reached).toBe(1);
      ctl.abort();
      await settle();
      expect((await post('The contestant left.')).body.reached).toBe(0);
    });

    it('FR-AUTH-09: announcements are admin-only to post, registered-only to read', async () => {
      await times(-MIN, 120 * MIN);
      const u = await registered();
      const post = (token: string | undefined, body: object) =>
        call('post', `/admin/contests/${c.id}/announcements`, token, body);
      expect((await post(u.token, { body: 'hi' })).status).toBe(403);
      expect((await post(undefined, { body: 'hi' })).status).toBe(401);
      expect((await post(admin.token, { body: '' })).status).toBe(400);
      expect((await post(admin.token, { body: 'Water in the corridor.' })).status).toBe(201);
      const list = await call('get', `/contests/${c.slug}/announcements`, u.token);
      expect(list.body.items[0]).toMatchObject({ body: 'Water in the corridor.' });
      expect(
        (await call('get', `/contests/${c.slug}/announcements`, (await makeUser()).token)).status,
      ).toBe(403);
      expect((await call('get', `/contests/${c.slug}/announcements`)).status).toBe(401);
    });

    it('answers and announcements are written to the audit log', async () => {
      const rows = await db.select().from(auditLog);
      const actions = new Set(rows.map((r) => r.action));
      expect(actions.has('clarification.answer')).toBe(true);
      expect(actions.has('contest.announce')).toBe(true);
      expect(rows.every((r) => r.actorId === admin.id)).toBe(true);
    });

    it('SD-§10: realtime tickets for the message topics follow who may hear them', async () => {
      const a = await registered();
      const other = await registered();
      const stranger = await makeUser();
      const ticket = (token: string | undefined, topics: string[]) =>
        call('post', '/realtime/ticket', token, { topics });
      expect(
        (await ticket(a.token, [`contest:${c.id}:clar`, `contest:${c.id}:u:${a.id}`])).status,
      ).toBe(200);
      // Not another contestant's private topic, not the admins' topic, not as a stranger or guest.
      expect((await ticket(a.token, [`contest:${c.id}:u:${other.id}`])).status).toBe(403);
      expect((await ticket(a.token, [`admin:contest:${c.id}:clar`])).status).toBe(403);
      expect((await ticket(stranger.token, [`contest:${c.id}:clar`])).status).toBe(403);
      expect((await ticket(undefined, [`contest:${c.id}:clar`])).status).toBe(403);
      expect((await ticket(admin.token, [`admin:contest:${c.id}:clar`])).status).toBe(200);
    });
  },
);
