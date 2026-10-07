import { Inject, Injectable } from '@nestjs/common';
import type {
  ProblemDetail,
  ProblemList,
  ProblemListQuery,
  ProblemTags,
} from '@codearena/contracts';
import { and, asc, eq, gt, ilike, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { practiceVisible } from './practice';
import { DB, type Db } from '../../db/db.module';
import { problemTags, problemVersions, problems, submissions } from '../../db/schema';

const encode = (difficulty: number, slug: string) =>
  Buffer.from(JSON.stringify([difficulty, slug])).toString('base64url');

function decode(cursor: string): [number, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string')
      return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new ProblemError('validation', 'cursor is not valid', {
    errors: [{ path: 'cursor', message: 'cursor is not valid' }],
  });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

@Injectable()
export class ProblemsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Public practice problems, easiest first (FR-PROB-08). Filters combine with AND. */
  async list(q: ProblemListQuery, userId?: string): Promise<ProblemList> {
    if (q.status && !userId) {
      throw new ProblemError('unauthorized', 'Sign in to filter by your progress');
    }
    const where: SQL[] = [practiceVisible, isNotNull(problems.currentVersionId)];
    if (q.q) where.push(ilike(problems.title, `%${escapeLike(q.q)}%`));
    if (q.minDiff !== undefined) where.push(sql`${problems.difficulty} >= ${q.minDiff}`);
    if (q.maxDiff !== undefined) where.push(sql`${problems.difficulty} <= ${q.maxDiff}`);
    if (q.tags && q.tags.length > 0) {
      where.push(
        inArray(
          problems.id,
          this.db
            .select({ id: problemTags.problemId })
            .from(problemTags)
            .where(inArray(problemTags.tag, q.tags))
            .groupBy(problemTags.problemId)
            .having(sql`count(distinct ${problemTags.tag}) = ${new Set(q.tags).size}`),
        ),
      );
    }
    if (q.status && userId) {
      const mine = (ac: boolean) => sql`exists (
        select 1 from ${submissions} s
        join ${problemVersions} v on v.id = s.problem_version_id
        where v.problem_id = ${problems.id} and s.user_id = ${userId}
        ${ac ? sql`and s.verdict = 'AC'` : sql``})`;
      where.push(
        q.status === 'solved'
          ? mine(true)
          : q.status === 'attempted'
            ? sql`${mine(false)} and not ${mine(true)}`
            : sql`not ${mine(false)}`,
      );
    }
    if (q.cursor) {
      const [d, slug] = decode(q.cursor);
      where.push(
        or(gt(problems.difficulty, d), and(eq(problems.difficulty, d), gt(problems.slug, slug)))!,
      );
    }
    const rows = await this.db
      .select({
        id: problems.id,
        slug: problems.slug,
        title: problems.title,
        difficulty: problems.difficulty,
        practicePoints: problems.practicePoints,
      })
      .from(problems)
      .where(and(...where))
      .orderBy(asc(problems.difficulty), asc(problems.slug))
      .limit(q.limit + 1);

    const items = rows.slice(0, q.limit);
    const tagRows =
      items.length === 0
        ? []
        : await this.db
            .select({ problemId: problemTags.problemId, tag: problemTags.tag })
            .from(problemTags)
            .where(
              inArray(
                problemTags.problemId,
                items.map((r) => r.id),
              ),
            )
            .orderBy(asc(problemTags.tag));
    const ids = items.map((r) => r.id);
    const stats = ids.length === 0 ? [] : await this.stats(ids);
    const mine = ids.length === 0 || !userId ? [] : await this.mine(ids, userId);
    const last = items.at(-1);
    return {
      items: items.map(({ id, ...r }) => {
        const st = stats.find((x) => x.problemId === id);
        const total = Number(st?.total ?? 0);
        const m = mine.find((x) => x.problemId === id);
        return {
          ...r,
          tags: tagRows.filter((t) => t.problemId === id).map((t) => t.tag),
          acceptance: total === 0 ? null : Math.round((Number(st!.accepted) / total) * 1000) / 10,
          status: !userId ? null : !m ? 'new' : m.solved ? 'solved' : 'attempted',
        };
      }),
      nextCursor: rows.length > q.limit && last ? encode(last.difficulty, last.slug) : null,
    };
  }

  /** Tags used by public problems, most used first. */
  async tags(): Promise<ProblemTags> {
    const rows = await this.db
      .select({ tag: problemTags.tag, count: sql<number>`count(*)::int` })
      .from(problemTags)
      .innerJoin(problems, eq(problems.id, problemTags.problemId))
      .where(and(practiceVisible, isNotNull(problems.currentVersionId)))
      .groupBy(problemTags.tag)
      .orderBy(sql`count(*) desc`, asc(problemTags.tag));
    return { items: rows };
  }

  /** Accepted / all submissions per problem, over every version. */
  private async stats(ids: string[]) {
    const rows = await this.db.execute<{ problemId: string; total: string; accepted: string }>(sql`
      select v.problem_id as "problemId", count(*) as total,
             count(*) filter (where s.verdict = 'AC') as accepted
      from ${submissions} s join ${problemVersions} v on v.id = s.problem_version_id
      where v.problem_id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})
        and s.verdict is not null and not s.disqualified
      group by v.problem_id`);
    return rows.rows;
  }

  /** Which of these problems the user has tried, and whether any try was accepted. */
  private async mine(ids: string[], userId: string) {
    const rows = await this.db.execute<{ problemId: string; solved: boolean }>(sql`
      select v.problem_id as "problemId", bool_or(s.verdict = 'AC') as solved
      from ${submissions} s join ${problemVersions} v on v.id = s.problem_version_id
      where s.user_id = ${userId} and v.problem_id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})
      group by v.problem_id`);
    return rows.rows;
  }

  /** 404 for anything not public: hidden problems must not reveal that they exist (FR-PROB-09). */
  async detail(slug: string): Promise<ProblemDetail> {
    const [row] = await this.db
      .select({
        id: problems.id,
        slug: problems.slug,
        title: problems.title,
        difficulty: problems.difficulty,
        practicePoints: problems.practicePoints,
        version: problemVersions.version,
        testsCount: problemVersions.testsCount,
        statementMd: problemVersions.statementMd,
        samples: problemVersions.samples,
        limits: problemVersions.limits,
        checker: problemVersions.checker,
      })
      .from(problems)
      .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
      .where(and(eq(problems.slug, slug), practiceVisible))
      .limit(1);
    if (!row) throw new ProblemError('not-found', 'No such problem');
    const tags = await this.db
      .select({ tag: problemTags.tag })
      .from(problemTags)
      .where(eq(problemTags.problemId, row.id))
      .orderBy(asc(problemTags.tag));
    const checker = row.checker as { kind: ProblemDetail['checker']['kind']; eps?: number };
    return {
      slug: row.slug,
      title: row.title,
      difficulty: row.difficulty,
      practicePoints: row.practicePoints,
      version: row.version,
      testsCount: row.testsCount,
      statementMd: row.statementMd,
      tags: tags.map((t) => t.tag),
      samples: row.samples as ProblemDetail['samples'],
      limits: row.limits as ProblemDetail['limits'],
      // The checker's source location stays server-side (FR-PROB-06).
      checker:
        checker.eps === undefined
          ? { kind: checker.kind }
          : { kind: checker.kind, eps: checker.eps },
    };
  }
}
