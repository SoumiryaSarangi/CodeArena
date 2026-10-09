import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContestRules } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  auditLog,
  contestProblems,
  contests,
  problemVersions,
  problems,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { CANARY_TOKEN, canaryText, containsCanary, newCanaryToken } from './canary';

const ready = await postgresReachable();
const csrf = randomBytes(32).toString('base64url');
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const P1 = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory())!.name;
const HOUR = 3_600_000;

describe('FR-SIG-03: the canary token and its detection', () => {
  it('is a valid identifier in the supported languages, 8 random characters, and not repeated', () => {
    const tokens = Array.from({ length: 200 }, newCanaryToken);
    for (const t of tokens) {
      expect(t).toMatch(CANARY_TOKEN);
      expect(t).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(new Set(tokens).size).toBe(200);
  });

  it('the hidden sentence names the token and says it is for automated assistants', () => {
    const t = newCanaryToken();
    expect(canaryText(t)).toContain(t);
    expect(canaryText(t)).toMatch(/automated assistants/);
  });

  it('is found as a whole identifier in any letter case, not inside a longer name, null when no canary was set', () => {
    const t = 'ans_k3x9q2mz';
    expect(containsCanary(`int ${t} = 0;`, t)).toBe(true);
    expect(containsCanary(`${t.toUpperCase()} = 0`, t)).toBe(true);
    expect(containsCanary(`x = ${t}+1`, t)).toBe(true);
    expect(containsCanary(`int my_${t} = 0;`, t)).toBe(false);
    expect(containsCanary(`int ${t}2 = 0;`, t)).toBe(false);
    expect(containsCanary('int answer = 0;', t)).toBe(false);
    expect(containsCanary('int answer = 0;', null)).toBeNull();
  });
});

describe.skipIf(!ready)(
  'IN-02: the canary switch, the statement and the review (needs the Compose Postgres)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;
    let admin: { id: string; token: string };
    let problemId: string;
    let versionId: string;

    const makeUser = async (role: 'user' | 'admin' = 'user') => {
      const id = randomUUID();
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, role, handle: `u${id.slice(0, 8)}` });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token };
    };
    const makeContest = async () => {
      const [c] = await db
        .insert(contests)
        .values({
          slug: `cn-${randomBytes(4).toString('hex')}`,
          title: 'Canary contest',
          startsAt: new Date(Date.now() - HOUR),
          endsAt: new Date(Date.now() + HOUR),
          rules: ContestRules.parse({}),
          status: 'scheduled',
          createdBy: admin.id,
        })
        .returning({ id: contests.id, slug: contests.slug });
      await db
        .insert(contestProblems)
        .values({ contestId: c!.id, label: 'A', problemId, versionId, position: 0 });
      return c!;
    };
    const call = (method: 'get' | 'post', path: string, bearer?: string, body?: unknown) => {
      const agent = request(app.getHttpServer());
      const r = agent[method](`/api${path}`).set('Cookie', `ca_csrf=${csrf}`);
      if (bearer) r.set('Authorization', `Bearer ${bearer}`).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body as object);
    };
    const statement = (slug: string) => call('get', `/contests/${slug}/problems/A`, admin.token);
    const row = async (contestId: string) =>
      (
        await db
          .select()
          .from(contestProblems)
          .where(and(eq(contestProblems.contestId, contestId), eq(contestProblems.label, 'A')))
      )[0]!;

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      app = await createApp(
        loadConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          RATE_LIMIT_DEFAULT_PER_MIN: '100000',
          RATE_LIMIT_ANON_PER_MIN: '100000',
          DATABASE_URL: t.url,
        }),
      );
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      const r = parsePackage(P1, readPackageDirectory(`${root}${P1}`));
      if (!r.ok) throw new Error('package rejected');
      await app.get(ProblemImporter).import(r.pkg, { visibility: 'public' });
      const [p] = await db
        .select({ id: problems.id, v: problemVersions.id })
        .from(problems)
        .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
        .where(eq(problems.slug, P1));
      problemId = p!.id;
      versionId = p!.v;
      admin = await makeUser('admin');
    });
    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    it('is off by default: the statement carries no hidden text and the admin view says off', async () => {
      const c = await makeContest();
      const s = await statement(c.slug);
      expect(s.status).toBe(200);
      expect(s.body.canaryText ?? null).toBeNull();
      expect((await row(c.id)).canaryOn).toBe(false);
      expect((await row(c.id)).canaryToken).toBeNull();
      const detail = await call('get', `/admin/contests/${c.id}`, admin.token);
      expect(detail.body.problems[0].canaryOn).toBe(false);
    });

    it('only an admin switches it; on gives the statement the hidden sentence with a stable token, off removes the sentence but keeps the token; audited', async () => {
      const c = await makeContest();
      const path = `/admin/contests/${c.id}/problems/A/canary`;
      const user = await makeUser();
      expect((await call('post', path, undefined, { enabled: true })).status).toBe(401);
      expect((await call('post', path, user.token, { enabled: true })).status).toBe(403);
      for (const bad of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
        expect((await call('post', path, admin.token, bad)).status).toBe(400);
      }
      expect(
        (
          await call('post', `/admin/contests/${c.id}/problems/Z/canary`, admin.token, {
            enabled: true,
          })
        ).status,
      ).toBe(404);

      expect((await call('post', path, admin.token, { enabled: true })).body).toEqual({
        enabled: true,
      });
      const token = (await row(c.id)).canaryToken!;
      expect(token).toMatch(CANARY_TOKEN);
      expect((await statement(c.slug)).body.canaryText).toBe(canaryText(token));
      expect(
        (await call('get', `/admin/contests/${c.id}`, admin.token)).body.problems[0].canaryOn,
      ).toBe(true);

      await call('post', path, admin.token, { enabled: false });
      expect((await statement(c.slug)).body.canaryText ?? null).toBeNull();
      expect((await row(c.id)).canaryToken).toBe(token); // kept, so a submission can still be checked
      await call('post', path, admin.token, { enabled: true });
      expect((await row(c.id)).canaryToken).toBe(token); // the same name when switched on again

      const log = await db.select().from(auditLog).where(eq(auditLog.targetId, c.id));
      expect(log.map((l) => l.action).sort()).toEqual([
        'contest.canary-off',
        'contest.canary-on',
        'contest.canary-on',
      ]);
    });

    it('replacing the contest problem list keeps the canary of a problem that stays', async () => {
      const [c] = await db
        .insert(contests)
        .values({
          slug: `cn-${randomBytes(4).toString('hex')}`,
          title: 'Draft',
          startsAt: new Date(Date.now() + 5 * HOUR),
          endsAt: new Date(Date.now() + 8 * HOUR),
          rules: ContestRules.parse({}),
          status: 'draft',
          createdBy: admin.id,
        })
        .returning({ id: contests.id });
      await db
        .insert(contestProblems)
        .values({ contestId: c!.id, label: 'A', problemId, versionId, position: 0 });
      await call('post', `/admin/contests/${c!.id}/problems/A/canary`, admin.token, {
        enabled: true,
      });
      const before = await row(c!.id);
      const put = await request(app.getHttpServer())
        .put(`/api/admin/contests/${c!.id}/problems`)
        .set('Cookie', `ca_csrf=${csrf}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('X-CSRF-Token', csrf)
        .send({ items: [{ label: 'B', slug: P1 }] });
      expect(put.status).toBe(200);
      const after = (
        await db.select().from(contestProblems).where(eq(contestProblems.contestId, c!.id))
      )[0]!;
      expect(after.label).toBe('B');
      expect(after.canaryOn).toBe(true);
      expect(after.canaryToken).toBe(before.canaryToken);
    });
  },
);
