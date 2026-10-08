/**
 * O-06 failure drills: what must be true after a fault, however it was injected (NFR-REL-01).
 * Run next to the database and Redis (`load-cli verify <slug>`); the board comparison is done by the
 * driver over HTTP, because it needs the API's rebuild.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '../../db/client';
import { contests, judgeRuns, submissions } from '../../db/schema';

export interface Verification {
  ok: boolean;
  /** Plain sentences, one per broken invariant; empty when ok. */
  problems: string[];
  /** Things that could not be checked (a Redis command the user is not allowed to run). */
  notChecked: string[];
  contest: string;
  /** Every stored submission, including the failed ones below. */
  submissions: number;
  /**
   * Submissions the API could not queue (Redis was down): stored as `failed` and refused to the
   * contestant with an error, by design (they resubmit). Not a lost verdict, so not a problem.
   */
  failedSubmissions: number;
  withVerdict: number;
  byVerdict: Record<string, number>;
  /** Entries per job in the retained part of the `results` stream, more than 1 = a duplicate publish. */
  resultEntries: number;
  duplicateResultEntries: number;
  resultsDlq: number;
  jobsDlq: number;
  pendingJobs: number;
}

export interface VerifyOptions {
  /** The poison drill expects exactly this many entries in `jobs:dlq`, other drills 0. */
  expectJobsDlq?: number;
  prefix?: string;
}

const LANES = ['contest', 'practice', 'rejudge'];

const jsonObjects = (fields: string[]): Record<string, unknown>[] =>
  fields.flatMap((f) => {
    try {
      const v: unknown = JSON.parse(f);
      return v && typeof v === 'object' ? [v as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

export async function verifyContest(
  db: Db,
  redis: Redis | null,
  slug: string,
  opts: VerifyOptions = {},
): Promise<Verification> {
  const prefix = opts.prefix ?? '';
  const [c] = await db.select({ id: contests.id }).from(contests).where(eq(contests.slug, slug));
  if (!c) throw new Error(`no contest "${slug}"`);
  const problems: string[] = [];
  const notChecked: string[] = [];

  const subs = await db
    .select({
      id: submissions.id,
      verdict: submissions.verdict,
      status: submissions.status,
      run: submissions.currentRunVersion,
    })
    .from(submissions)
    .where(eq(submissions.contestId, c.id));
  const byVerdict: Record<string, number> = {};
  for (const s of subs) if (s.verdict) byVerdict[s.verdict] = (byVerdict[s.verdict] ?? 0) + 1;

  const failed = subs.filter((s) => s.status === 'failed' && s.verdict === null);
  const unjudged = subs.filter(
    (s) =>
      !(s.status === 'failed' && s.verdict === null) && (s.verdict === null || s.status !== 'done'),
  );
  if (unjudged.length > 0) {
    problems.push(
      `${unjudged.length} submission(s) have no final verdict (e.g. ${unjudged
        .slice(0, 3)
        .map((s) => s.id)
        .join(', ')})`,
    );
  }

  // Exactly one stored run for the version a submission is at.
  const runs = await db
    .select({ id: judgeRuns.submissionId, v: judgeRuns.runVersion, n: sql<number>`count(*)::int` })
    .from(judgeRuns)
    .innerJoin(submissions, eq(submissions.id, judgeRuns.submissionId))
    .where(and(eq(submissions.contestId, c.id)))
    .groupBy(judgeRuns.submissionId, judgeRuns.runVersion);
  const runCount = new Map(runs.map((r) => [`${r.id}:${r.v}`, r.n]));
  const noRun = subs.filter((s) => s.verdict !== null && !runCount.has(`${s.id}:${s.run}`));
  if (noRun.length > 0) {
    problems.push(`${noRun.length} judged submission(s) have no stored run for their version`);
  }
  const doubled = runs.filter((r) => r.n > 1);
  if (doubled.length > 0) problems.push(`${doubled.length} run(s) are stored more than once`);

  let resultEntries = 0;
  let duplicateResultEntries = 0;
  let resultsDlq = 0;
  let jobsDlq = 0;
  let pendingJobs = 0;
  if (redis) {
    const ids = new Set(subs.map((s) => s.id));
    try {
      const entries = await redis.xrange(`${prefix}results`, '-', '+');
      const seen = new Map<string, number>();
      for (const [, fields] of entries) {
        for (const o of jsonObjects(fields)) {
          const sid = typeof o.submissionId === 'string' ? o.submissionId : '';
          if (!ids.has(sid)) continue;
          resultEntries++;
          const k = `${sid}:${String(o.runVersion)}`;
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
      duplicateResultEntries = [...seen.values()].filter((n) => n > 1).length;
      if (duplicateResultEntries > 0) {
        problems.push(`${duplicateResultEntries} job(s) published more than one result`);
      }
    } catch (e) {
      notChecked.push(`results stream: ${(e as Error).message}`);
    }
    try {
      resultsDlq = await redis.xlen(`${prefix}results:dlq`);
      if (resultsDlq > 0) problems.push(`${resultsDlq} result(s) parked in results:dlq`);
    } catch (e) {
      notChecked.push(`results:dlq: ${(e as Error).message}`);
    }
    try {
      jobsDlq = await redis.xlen(`${prefix}jobs:dlq`);
      const want = opts.expectJobsDlq ?? 0;
      if (jobsDlq !== want) problems.push(`jobs:dlq has ${jobsDlq} entries, expected ${want}`);
    } catch (e) {
      notChecked.push(`jobs:dlq: ${(e as Error).message}`);
    }
    for (const lane of LANES) {
      try {
        const p = (await redis.xpending(`${prefix}jobs:${lane}`, 'judges')) as [
          number,
          ...unknown[],
        ];
        pendingJobs += Number(p?.[0] ?? 0);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/NOGROUP|no such key/i.test(msg)) notChecked.push(`jobs:${lane} pending: ${msg}`);
      }
    }
    if (pendingJobs > 0) problems.push(`${pendingJobs} job(s) are still claimed by a judge`);
  } else {
    notChecked.push('redis: not given');
  }

  return {
    ok: problems.length === 0,
    problems,
    notChecked,
    contest: slug,
    submissions: subs.length,
    failedSubmissions: failed.length,
    withVerdict: subs.filter((s) => s.verdict !== null).length,
    byVerdict,
    resultEntries,
    duplicateResultEntries,
    resultsDlq,
    jobsDlq,
    pendingJobs,
  };
}
