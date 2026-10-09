import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContestRules } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contestProblems,
  contests,
  editorSignals,
  participants,
  problemVersions,
  problems,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { jensenShannon, styleFeatures, styleShift, timeToAcMinutes } from './derive';
import { MAX_SIGNALS_PER_USER_CONTEST, RETENTION_DAYS, SignalsService } from './signals.service';

const ready = await postgresReachable();
const csrf = randomBytes(32).toString('base64url');
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const P1 = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory())!.name;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

// ---- the numbers derived from code (no database) ---------------------------------------------------------

const TIDY = (n: number) => `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n;
    cin >> n;
    long long total = ${n};
    for (int i = 0; i < n; i++) {
        total += i * 2;
    }
    cout << total << "\\n";
    return 0;
}
`;
const WILD = (n: number) => `#include <stdio.h>
#define LOOP_OVER_ALL_THE_THINGS(counterVariable,limitValue) for(counterVariable=0;counterVariable<limitValue;counterVariable++)
int main(void){
\tint theNumberOfElementsInTheInput,theRunningTotalSoFar=${n},theLoopCounterVariable;
\tscanf("%d",&theNumberOfElementsInTheInput); // read the size
\tLOOP_OVER_ALL_THE_THINGS(theLoopCounterVariable,theNumberOfElementsInTheInput){theRunningTotalSoFar+=theLoopCounterVariable*2;}
\tprintf("%d\\n",theRunningTotalSoFar); /* done */
\treturn 0;}
`;

describe('FR-SIG-01: the derived numbers (advisory, from code)', () => {
  it('Jensen-Shannon divergence: 0 for the same distribution, 1 for nothing in common, symmetric', () => {
    const a = new Map([
      ['x', 3],
      ['y', 1],
    ]);
    expect(jensenShannon(a, a)).toBeCloseTo(0, 10);
    expect(jensenShannon(new Map([['x', 1]]), new Map([['y', 1]]))).toBeCloseTo(1, 10);
    const b = new Map([
      ['x', 1],
      ['z', 4],
    ]);
    expect(jensenShannon(a, b)).toBeCloseTo(jensenShannon(b, a), 10);
    expect(jensenShannon(a, b)).toBeGreaterThan(0);
    expect(jensenShannon(a, b)).toBeLessThan(1);
  });

  it('style features keep the shape of the code, not the names', () => {
    const f = styleFeatures('int alpha = 1;\n    int beta = 22; // x\n');
    expect(f.get('kw:int')).toBe(2);
    expect(f.get('comment')).toBe(1);
    expect(f.get('indent:4')).toBe(1);
    expect([...f.keys()].some((k) => k.includes('alpha'))).toBe(false);
  });

  it('style shift is small for the same hand and large for another, and null without enough history', () => {
    const mine = [1, 2, 3, 4].map(TIDY);
    const same = styleShift(TIDY(9), mine)!;
    const other = styleShift(WILD(9), mine)!;
    expect(same).toBeLessThan(0.05);
    expect(other).toBeGreaterThan(same * 4);
    expect(other).toBeGreaterThan(0.2);
    expect(styleShift(TIDY(9), mine.slice(0, 2))).toBeNull(); // fewer than 3 earlier programs
    expect(styleShift('int x;', mine)).toBeNull(); // too short to say anything
    expect(styleShift(TIDY(9), ['int x;', 'int y;', 'int z;', 'int w;'])).toBeNull(); // history too short
  });

  it('time to AC: whole minutes from opening to the first AC; null if either is missing; never negative', () => {
    const open = new Date('2026-10-10T13:40:00Z');
    expect(timeToAcMinutes(open, new Date('2026-10-10T14:07:40Z'))).toBe(28);
    expect(timeToAcMinutes(null, new Date())).toBeNull();
    expect(timeToAcMinutes(open, null)).toBeNull();
    expect(timeToAcMinutes(open, new Date('2026-10-10T13:00:00Z'))).toBe(0);
  });
});

// ---- the endpoint, retention and the "never alters a score" rule ---------------------------------------

describe.skipIf(!ready)(
  'IN-01: POST /api/signals and retention (needs the Compose Postgres)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;
    let problemId: string;
    let versionId: string;

    const makeUser = async (role: 'user' | 'admin' | 'setter' = 'user') => {
      const id = randomUUID();
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, role, handle: `u${id.slice(0, 8)}` });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token };
    };
    const makeContest = async (opts: { startsAgoH?: number; endsInH?: number } = {}) => {
      const [c] = await db
        .insert(contests)
        .values({
          slug: `sg-${randomBytes(4).toString('hex')}`,
          title: 'Signals contest',
          startsAt: new Date(Date.now() - (opts.startsAgoH ?? 1) * HOUR),
          endsAt: new Date(Date.now() + (opts.endsInH ?? 1) * HOUR),
          rules: ContestRules.parse({}),
          status: 'scheduled',
          createdBy: (await makeUser('admin')).id,
        })
        .returning({ id: contests.id, slug: contests.slug });
      await db
        .insert(contestProblems)
        .values({ contestId: c!.id, label: 'A', problemId, versionId, position: 0 });
      return c!;
    };
    const register = (contestId: string, userId: string) =>
      db.insert(participants).values({ contestId, userId });
    const post = (token: string | undefined, body: unknown) => {
      const r = request(app.getHttpServer()).post('/api/signals').set('Cookie', `ca_csrf=${csrf}`);
      if (token) r.set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', csrf);
      return r.send(body as object);
    };
    const rows = (contestId: string) =>
      db.select().from(editorSignals).where(eq(editorSignals.contestId, contestId));

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
    });
    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    const batch = (c: { slug: string }, events: object[], problem = 'A') => ({
      contest: c.slug,
      problem,
      events,
    });

    it("FR-SIG-01: a registered contestant's pastes over 50 characters, focus losses and the problem opening are stored; small pastes are not", async () => {
      const c = await makeContest();
      const u = await makeUser();
      await register(c.id, u.id);
      const res = await post(
        u.token,
        batch(c, [
          { kind: 'problem_open', at: iso(-5 * 60_000) },
          { kind: 'paste', size: 800, at: iso(-4 * 60_000) },
          { kind: 'paste', size: 50, at: iso(-3 * 60_000) }, // not above 50: dropped
          { kind: 'paste', size: 51, at: iso(-2 * 60_000) },
          { kind: 'blur', at: iso(-60_000) },
          { kind: 'tab_hidden', at: iso(-59_000) },
          { kind: 'focus', at: iso(-30_000) },
        ]),
      );
      expect(res.status).toBe(204);
      const got = await rows(c.id);
      expect(got.map((r) => [r.kind, r.size]).sort()).toEqual(
        [
          ['blur', null],
          ['focus', null],
          ['paste', 51],
          ['paste', 800],
          ['problem_open', null],
          ['tab_hidden', null],
        ].sort(),
      );
      expect(got.every((r) => r.userId === u.id && r.problemId === problemId)).toBe(true);
    });

    it('only the first time a problem is opened is kept', async () => {
      const c = await makeContest();
      const u = await makeUser();
      await register(c.id, u.id);
      await post(
        u.token,
        batch(c, [
          { kind: 'problem_open', at: iso(-120_000) },
          { kind: 'problem_open', at: iso(-100_000) },
        ]),
      );
      await post(u.token, batch(c, [{ kind: 'problem_open', at: iso(-1000) }]));
      const opens = (await rows(c.id)).filter((r) => r.kind === 'problem_open');
      expect(opens).toHaveLength(1);
      expect(opens[0]!.at.getTime()).toBeLessThan(Date.now() - 100_000);
    });

    it('nothing is stored for staff, for people not registered, or when the contest is not running; unknown contest or problem is 404', async () => {
      const c = await makeContest();
      const ev = [{ kind: 'blur', at: iso(-1000) }];
      const staff = await makeUser('admin');
      const setter = await makeUser('setter');
      const stranger = await makeUser();
      for (const u of [staff, setter, stranger]) {
        await register(c.id, u.id).catch(() => undefined);
        if (u === stranger) await db.delete(participants).where(eq(participants.userId, u.id));
        expect((await post(u.token, batch(c, ev))).status).toBe(204);
      }
      expect(await rows(c.id)).toEqual([]);
      const over = await makeContest({ startsAgoH: 3, endsInH: -1 });
      const soon = await makeContest({ startsAgoH: -1, endsInH: 2 });
      const u = await makeUser();
      for (const x of [over, soon]) {
        await register(x.id, u.id);
        expect((await post(u.token, batch(x, ev))).status).toBe(204);
        expect(await rows(x.id)).toEqual([]);
      }
      expect((await post(u.token, { contest: 'nope-nope', problem: 'A', events: ev })).status).toBe(
        404,
      );
      expect((await post(u.token, batch(c, ev, 'Z'))).status).toBe(404);
    });

    it('a client clock cannot put a signal in the future or far in the past, and the total per person is capped', async () => {
      const c = await makeContest();
      const u = await makeUser();
      await register(c.id, u.id);
      await post(
        u.token,
        batch(c, [
          { kind: 'blur', at: iso(5 * HOUR) },
          { kind: 'focus', at: iso(-3 * DAY) },
        ]),
      );
      const got = await rows(c.id);
      expect(got).toHaveLength(2);
      for (const r of got) expect(Math.abs(r.at.getTime() - Date.now())).toBeLessThan(10_000);
      await db.insert(editorSignals).values(
        Array.from({ length: MAX_SIGNALS_PER_USER_CONTEST - 2 }, () => ({
          userId: u.id,
          contestId: c.id,
          problemId,
          kind: 'blur' as const,
        })),
      );
      await post(u.token, batch(c, [{ kind: 'blur', at: iso(-1000) }]));
      expect(await rows(c.id)).toHaveLength(MAX_SIGNALS_PER_USER_CONTEST);
    });

    it('refuses no sign-in (401) and malformed batches (400): extra fields, empty, over 50 events, unknown kind, bad time', async () => {
      const c = await makeContest();
      const u = await makeUser();
      await register(c.id, u.id);
      const ok = { kind: 'blur', at: iso(-1000) };
      expect((await post(undefined, batch(c, [ok]))).status).toBe(401);
      for (const bad of [
        { ...batch(c, [ok]), extra: 1 },
        batch(c, []),
        batch(
          c,
          Array.from({ length: 51 }, () => ok),
        ),
        batch(c, [{ kind: 'keystroke', at: iso() }]),
        batch(c, [{ kind: 'blur', at: 'yesterday' }]),
        batch(c, [{ kind: 'paste', size: 0, at: iso() }]),
        { contest: c.slug, events: [ok] },
      ]) {
        expect((await post(u.token, bad)).status, JSON.stringify(bad).slice(0, 50)).toBe(400);
      }
      expect(await rows(c.id)).toEqual([]);
    });

    it(`FR-SIG-02: signals of a contest that ended more than ${RETENTION_DAYS} days ago are deleted, newer ones are kept`, async () => {
      const old = await makeContest({ startsAgoH: 24 * 40, endsInH: -24 * (RETENTION_DAYS + 1) });
      const recent = await makeContest({
        startsAgoH: 24 * 40,
        endsInH: -24 * (RETENTION_DAYS - 1),
      });
      const running = await makeContest();
      const u = await makeUser();
      for (const c of [old, recent, running]) {
        await db
          .insert(editorSignals)
          .values({ userId: u.id, contestId: c.id, problemId, kind: 'paste', size: 99 });
      }
      const n = await app.get(SignalsService).purge();
      expect(n).toBeGreaterThanOrEqual(1);
      expect(await rows(old.id)).toEqual([]);
      expect(await rows(recent.id)).toHaveLength(1);
      expect(await rows(running.id)).toHaveLength(1);
      expect(await app.get(SignalsService).purge()).toBe(0); // idempotent
    });
  },
);

describe('FR-SIG-02: signals never alter a score', () => {
  it('only the plagiarism review and the signals module read the signals table', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const rel = p.slice(src.length);
          if (
            readFileSync(p, 'utf8').includes('editorSignals') &&
            !/^(modules\/(plag|signals)\/|db\/schema\/)/.test(rel)
          )
            offenders.push(rel);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
