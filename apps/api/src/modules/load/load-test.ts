/**
 * O-03 load-test support: fake users and a contest to submit into, the server-side numbers after a
 * run, and the cleanup. Used by `load-cli.ts`; tested against the Compose Postgres.
 *
 * Everything this creates is tagged so cleanup removes only it: users have an `@loadtest.invalid`
 * e-mail, the contest slug starts with `lt-`. Nothing here touches other users or contests.
 */
import { randomBytes } from 'node:crypto';
import { ContestRules } from '@codearena/contracts';
import { eq, inArray, like, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/client';
import { contestProblems, contests, participants, problems, users } from '../../db/schema';
import { TokensService } from '../auth/tokens.service';

export const LOAD_EMAIL_DOMAIN = 'loadtest.invalid';
export const LOAD_SLUG_PREFIX = 'lt-';
export const DEFAULT_PROBLEMS = ['sum-two-numbers', 'stair-climb', 'rainfall-totals'];

export interface LoadSeed {
  contest: { id: string; slug: string; problems: { label: string; slug: string }[] };
  admin: { handle: string; refreshToken: string };
  users: { handle: string; refreshToken: string }[];
}

const loadUsers = () => like(users.email, `%@${LOAD_EMAIL_DOMAIN}`);

/** An admin, `count` users registered in a running contest, and a refresh token for each. */
export async function seedLoad(
  db: Db,
  log: Logger,
  opts: { count: number; problems?: string[]; tag?: string },
): Promise<LoadSeed> {
  const tag = opts.tag ?? randomBytes(3).toString('hex');
  const slugs = opts.problems ?? DEFAULT_PROBLEMS;
  const found = await db
    .select({ id: problems.id, slug: problems.slug, versionId: problems.currentVersionId })
    .from(problems)
    .where(inArray(problems.slug, slugs));
  const labelled = slugs.map((slug, i) => {
    const p = found.find((f) => f.slug === slug);
    if (!p?.versionId) throw new Error(`problem "${slug}" is not imported`);
    return { label: String.fromCharCode(65 + i), slug, id: p.id, versionId: p.versionId };
  });

  const tokens = new TokensService(db, log);
  const mk = async (handle: string, role: 'user' | 'admin') => {
    const [u] = await db
      .insert(users)
      .values({ handle, email: `${handle}@${LOAD_EMAIL_DOMAIN}`, role })
      .returning({ id: users.id });
    const issued = await tokens.issue(u!.id, 'load-test');
    return { id: u!.id, handle, refreshToken: issued.token };
  };

  const admin = await mk(`lt-admin-${tag}`, 'admin');
  const slug = `${LOAD_SLUG_PREFIX}${tag}`;
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      slug,
      title: `Load test ${tag}`,
      startsAt: new Date(now - 5 * 60_000),
      endsAt: new Date(now + 6 * 3600_000),
      rules: ContestRules.parse({}),
      status: 'scheduled',
      createdBy: admin.id,
    })
    .returning({ id: contests.id });
  await db.insert(contestProblems).values(
    labelled.map((p, i) => ({
      contestId: contest!.id,
      label: p.label,
      problemId: p.id,
      versionId: p.versionId,
      position: i,
    })),
  );

  const out: LoadSeed['users'] = [];
  for (let i = 1; i <= opts.count; i++) {
    const u = await mk(`lt-${tag}-${String(i).padStart(4, '0')}`, 'user');
    await db.insert(participants).values({ contestId: contest!.id, userId: u.id });
    out.push({ handle: u.handle, refreshToken: u.refreshToken });
  }
  return {
    contest: {
      id: contest!.id,
      slug,
      problems: labelled.map((p) => ({ label: p.label, slug: p.slug })),
    },
    admin: { handle: admin.handle, refreshToken: admin.refreshToken },
    users: out,
  };
}

export interface Stat {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface LoadReport {
  contest: string;
  submissions: number;
  judged: number;
  byVerdict: Record<string, number>;
  byLanguage: Record<string, number>;
  /** Seconds. Queue wait = a worker claimed it − submitted (from the stored journey). */
  queueWait: Stat;
  /** Seconds. Submitted → verdict stored. */
  timeToVerdict: Stat;
  /** Seconds a worker spent per run, by language (compile + tests). */
  serviceTime: Record<string, Stat>;
  workers: { id: string; runs: number; firstStartSeconds: number }[];
  /** First submission → last submission, in seconds. */
  submitWindowSeconds: number;
  /** Last submission → last verdict: how long the backlog took to clear after the burst ended. */
  drainSeconds: number | null;
  /** Judged submissions per second between the first worker start and the last verdict. */
  throughputPerSecond: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const stat = (r: Record<string, unknown>): Stat => ({
  n: Number(r.n ?? 0),
  mean: num(r.mean),
  p50: num(r.p50),
  p95: num(r.p95),
  max: num(r.max),
});

/** What the database saw for one load-test contest (latest run of each submission). */
export async function reportLoad(db: Db, slug: string): Promise<LoadReport> {
  const [c] = await db.select({ id: contests.id }).from(contests).where(eq(contests.slug, slug));
  if (!c) throw new Error(`no contest "${slug}"`);
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows;
  const id = c.id;

  const totals = (
    await rows(sql`select count(*)::int as total, count(verdict)::int as judged,
      extract(epoch from (max(created_at) - min(created_at))) as window_s,
      extract(epoch from (max(judged_at) - max(created_at))) as drain_s
      from submissions where contest_id = ${id}`)
  )[0]!;
  const group = async (col: 'verdict' | 'language') =>
    Object.fromEntries(
      (
        await rows(
          sql`select ${sql.raw(col)} as k, count(*)::int as n from submissions
            where contest_id = ${id} and ${sql.raw(col)} is not null group by 1`,
        )
      ).map((r) => [String(r.k), Number(r.n)]),
    );

  const pct = (expr: string) => `count(*)::int as n, avg(${expr}) as mean,
    percentile_cont(0.5) within group (order by ${expr}) as p50,
    percentile_cont(0.95) within group (order by ${expr}) as p95, max(${expr}) as max`;
  // The worker's first progress event (`claimed`, from the journey the verdict stores) is when it
  // picked the job up: judge_runs.started_at is not filled by the result path.
  const claimedAt = `to_timestamp(((r.journey->'steps'->0->>'at')::bigint) / 1000.0)`;
  const claimed = `r.journey->'steps'->0->>'phase' = 'claimed'`;
  const wait = `extract(epoch from (${claimedAt} - s.created_at))`;
  const ttv = `extract(epoch from (s.judged_at - s.created_at))`;
  const run = `extract(epoch from (r.finished_at - ${claimedAt}))`;
  const joined = `from submissions s join judge_runs r on r.submission_id = s.id
    and r.run_version = s.current_run_version`;

  const queueWait = (
    await rows(sql.raw(`select ${pct(wait)} ${joined} where s.contest_id = '${id}' and ${claimed}`))
  )[0]!;
  const timeToVerdict = (
    await rows(
      sql.raw(
        `select ${pct(ttv)} from submissions s where s.contest_id = '${id}' and s.judged_at is not null`,
      ),
    )
  )[0]!;
  const service = await rows(
    sql.raw(`select s.language as k, ${pct(run)} ${joined}
      where s.contest_id = '${id}' and ${claimed} and r.finished_at is not null group by s.language`),
  );
  const workers = await rows(
    sql.raw(`select r.worker_id as id, count(*)::int as runs,
      extract(epoch from (min(${claimedAt}) - (select min(created_at) from submissions where contest_id = '${id}'))) as first_s
      ${joined} where s.contest_id = '${id}' and r.worker_id is not null and ${claimed}
      group by 1 order by first_s`),
  );
  const span = (
    await rows(
      sql.raw(`select extract(epoch from (max(s.judged_at) - min(${claimedAt}))) as s
        ${joined} where s.contest_id = '${id}' and ${claimed}`),
    )
  )[0]!;
  const judged = Number(totals.judged);
  return {
    contest: slug,
    submissions: Number(totals.total),
    judged,
    byVerdict: await group('verdict'),
    byLanguage: await group('language'),
    queueWait: stat(queueWait),
    timeToVerdict: stat(timeToVerdict),
    serviceTime: Object.fromEntries(service.map((r) => [String(r.k), stat(r)])),
    workers: workers.map((w) => ({
      id: String(w.id),
      runs: Number(w.runs),
      firstStartSeconds: Number(w.first_s),
    })),
    submitWindowSeconds: Number(totals.window_s ?? 0),
    drainSeconds: num(totals.drain_s),
    throughputPerSecond: num(span.s) && Number(span.s) > 0 ? judged / Number(span.s) : null,
  };
}

/** Rows removed by `cleanupLoad`, for the log. */
export interface Cleaned {
  users: number;
  contests: number;
  submissions: number;
}

/** Deletes the load-test users, their submissions and the `lt-*` contests. Nothing else. */
export async function cleanupLoad(db: Db): Promise<Cleaned> {
  return db.transaction(async (tx) => {
    const ids = sql`(select id from users where email like ${`%@${LOAD_EMAIL_DOMAIN}`})`;
    const cids = sql`(select id from contests where slug like ${`${LOAD_SLUG_PREFIX}%`})`;
    const subs = sql`(select id from submissions where user_id in ${ids} or contest_id in ${cids})`;
    const del = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rowCount ?? 0;

    await del(sql`delete from test_results where judge_run_id in
      (select id from judge_runs where submission_id in ${subs})`);
    await del(sql`delete from judge_runs where submission_id in ${subs}`);
    const nSubs = await del(sql`delete from submissions where id in ${subs}`);
    for (const t of ['custom_runs', 'product_events', 'refresh_tokens', 'participants']) {
      await del(sql`delete from ${sql.identifier(t)} where user_id in ${ids}`);
    }
    await del(sql`delete from participants where contest_id in ${cids}`);
    await del(sql`delete from rating_changes where user_id in ${ids} or contest_id in ${cids}`);
    await del(sql`delete from audit_log where actor_id in ${ids}`);
    await del(sql`delete from announcements where contest_id in ${cids} or created_by in ${ids}`);
    await del(sql`delete from clarifications where contest_id in ${cids} or asker_id in ${ids}`);
    await del(sql`delete from contest_problems where contest_id in ${cids}`);
    const nContests = await del(
      sql`delete from contests where slug like ${`${LOAD_SLUG_PREFIX}%`}`,
    );
    const nUsers = await del(sql`delete from users where email like ${`%@${LOAD_EMAIL_DOMAIN}`}`);
    return { users: nUsers, contests: nContests, submissions: nSubs };
  });
}

/** True if any load-test data is present (a second seed on top of an old run is refused). */
export async function hasLoadData(db: Db): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(loadUsers()).limit(1);
  const [c] = await db
    .select({ id: contests.id })
    .from(contests)
    .where(like(contests.slug, `${LOAD_SLUG_PREFIX}%`))
    .limit(1);
  return Boolean(u ?? c);
}
