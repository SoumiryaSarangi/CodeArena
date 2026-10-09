import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '../../db/client';
import { contests, plagClusters, plagRuns, reviewDecisions, reviews } from '../../db/schema';
import { reportLoad } from './load-test';
import { verifyContest } from './verify';

/**
 * W-00: the numbers of one real contest, read-only, for `docs/METRICS.md` (`scripts/metrics-report.mjs --contest`).
 * Participants, submissions and their pace, time to verdict, verdict mix, workers, dead letters, whether every verdict
 * exists exactly once, the plagiarism run and the AI reviews. Works on any contest, load-test or real.
 */
export interface ContestReport {
  contest: { slug: string; title: string; startsAt: string; endsAt: string; status: string };
  generatedAt: string;
  participants: { registered: number; submitted: number; solvedOne: number };
  submissions: {
    total: number;
    judged: number;
    byVerdict: Record<string, number>;
    byLanguage: Record<string, number>;
    /** Submissions in the busiest minute, when it was, and the mean over the contest's length. */
    peakPerMinute: number;
    peakMinuteAt: string | null;
    meanPerMinute: number;
  };
  timeToVerdict: { n: number; p50: number | null; p95: number | null; max: number | null };
  queueWait: { n: number; p50: number | null; p95: number | null; max: number | null };
  workers: { id: string; runs: number }[];
  /** null when Redis was not reachable. */
  deadLetters: { jobs: number | null; results: number | null };
  /** Every judged verdict stored once, nothing stuck (the O-06 check); `problems` says what is wrong. */
  integrity: { ok: boolean; problems: string[]; notChecked: string[] };
  plagiarism: {
    runs: number;
    latest: {
      status: string;
      clusters: number;
      open: number;
      cleared: number;
      confirmed: number;
      discuss: number;
    } | null;
  };
  reviews: {
    total: number;
    byStatus: Record<string, number>;
    tokens: number;
    models: Record<string, number>;
    helpful: { yes: number; no: number };
  };
}

const stat = (s: { n: number; p50: number | null; p95: number | null; max: number | null }) => ({
  n: s.n,
  p50: s.p50,
  p95: s.p95,
  max: s.max,
});

export async function contestReport(
  db: Db,
  redis: Redis | null,
  slug: string,
  opts: { prefix?: string; now?: Date } = {},
): Promise<ContestReport> {
  const [c] = await db.select().from(contests).where(eq(contests.slug, slug));
  if (!c) throw new Error(`no contest "${slug}"`);
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows;
  const id = c.id;

  const load = await reportLoad(db, slug);
  const people = (
    await rows(sql`select
      (select count(*)::int from participants where contest_id = ${id}) as registered,
      (select count(distinct user_id)::int from submissions where contest_id = ${id}) as submitted,
      (select count(distinct user_id)::int from submissions where contest_id = ${id} and verdict = 'AC') as solved`)
  )[0]!;
  const peak = (
    await rows(sql`select date_trunc('minute', created_at) as m, count(*)::int as n
      from submissions where contest_id = ${id} group by 1 order by n desc, m limit 1`)
  )[0];
  const minutes = Math.max(1, (c.endsAt.getTime() - c.startsAt.getTime()) / 60_000);

  const prefix = opts.prefix ?? '';
  const dlq = async (name: string) => {
    if (!redis) return null;
    try {
      return await redis.xlen(`${prefix}${name}`);
    } catch {
      return null;
    }
  };
  const verified = await verifyContest(db, redis, slug, { prefix });

  const [run] = await db
    .select()
    .from(plagRuns)
    .where(eq(plagRuns.contestId, id))
    .orderBy(sql`${plagRuns.id} desc`)
    .limit(1);
  const runCount = (
    await rows(sql`select count(*)::int as n from plag_runs where contest_id = ${id}`)
  )[0]!;
  let latest: ContestReport['plagiarism']['latest'] = null;
  if (run) {
    const cl = await db
      .select({ id: plagClusters.id })
      .from(plagClusters)
      .where(eq(plagClusters.runId, run.id));
    const last = new Map<string, string>();
    if (cl.length > 0) {
      const decided = await db
        .select({ clusterId: reviewDecisions.clusterId, decision: reviewDecisions.decision })
        .from(reviewDecisions)
        .innerJoin(plagClusters, eq(plagClusters.id, reviewDecisions.clusterId))
        .where(eq(plagClusters.runId, run.id))
        .orderBy(reviewDecisions.createdAt, reviewDecisions.id);
      for (const d of decided) last.set(d.clusterId, d.decision);
    }
    const count = (k: string) => [...last.values()].filter((v) => v === k).length;
    latest = {
      status: run.status,
      clusters: cl.length,
      open: cl.length - last.size,
      cleared: count('dismissed'),
      confirmed: count('confirmed'),
      discuss: count('needs_more'),
    };
  }

  const rv = await db
    .select({
      status: reviews.status,
      model: reviews.model,
      tokens: reviews.tokens,
      helpful: reviews.helpful,
    })
    .from(reviews)
    .where(and(eq(reviews.contestId, id)));
  const tally = <T extends string | null>(xs: T[]) => {
    const o: Record<string, number> = {};
    for (const x of xs) if (x) o[x] = (o[x] ?? 0) + 1;
    return o;
  };

  return {
    contest: {
      slug,
      title: c.title,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      status: c.status,
    },
    generatedAt: (opts.now ?? new Date()).toISOString(),
    participants: {
      registered: Number(people.registered),
      submitted: Number(people.submitted),
      solvedOne: Number(people.solved),
    },
    submissions: {
      total: load.submissions,
      judged: load.judged,
      byVerdict: load.byVerdict,
      byLanguage: load.byLanguage,
      peakPerMinute: peak ? Number(peak.n) : 0,
      peakMinuteAt: peak ? new Date(String(peak.m)).toISOString() : null,
      meanPerMinute: Math.round((load.submissions / minutes) * 100) / 100,
    },
    timeToVerdict: stat(load.timeToVerdict),
    queueWait: stat(load.queueWait),
    workers: load.workers.map((w) => ({ id: w.id, runs: w.runs })),
    deadLetters: { jobs: await dlq('jobs:dlq'), results: await dlq('results:dlq') },
    integrity: { ok: verified.ok, problems: verified.problems, notChecked: verified.notChecked },
    plagiarism: { runs: Number(runCount.n), latest },
    reviews: {
      total: rv.length,
      byStatus: tally(rv.map((r) => r.status)),
      tokens: rv.reduce((a, r) => a + (r.tokens ?? 0), 0),
      models: tally(rv.map((r) => r.model)),
      helpful: {
        yes: rv.filter((r) => r.helpful === true).length,
        no: rv.filter((r) => r.helpful === false).length,
      },
    },
  };
}
