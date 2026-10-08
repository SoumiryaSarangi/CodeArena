import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateHint,
  HINT_PENALTY_PERCENT,
  type HintItem,
  type HintLevel,
  type HintResult,
  type HintState,
} from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { and, desc, eq, gt, lte, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../../common/problem';
import { DB, type Db } from '../../../db/db.module';
import {
  contestProblems,
  contests,
  hintRequests,
  problemVersions,
  problems,
  productEvents,
  submissions,
} from '../../../db/schema';
import { LOGGER } from '../../../telemetry/logger';
import { practiceVisible } from '../../problems/practice';
import { aiCacheKey, AiCache, normaliseCode } from '../cache';
import { AiLedger } from '../ledger';
import { AiRouter } from '../router';
import { filterHint, GENERIC_HINTS } from './hint-filter';
import {
  CODE_REMOVAL,
  HINT_MAIN,
  HINT_PROMPT_VERSION,
  type HintContext,
  SUFFICIENCY,
} from './hint-prompts';

const tracer = trace.getTracer('api');
const hintsTotal = metrics
  .getMeter('api')
  .createCounter('ca_hints_total', { description: 'Hint requests by level and outcome' });

/** FR-AI-06: hints per user per hour. */
export const HINTS_PER_HOUR = 10;
const BUSY = 'Hints are busy, try again in a minute.';
const DEFAULT_NUDGE =
  'Write and run an attempt first, then ask again: a hint works best on your own code.';

interface Target {
  problemId: string;
  slug: string;
  title: string;
  versionId: string;
  statementMd: string;
  editorialMd: string | null;
  avoidSet: Record<string, string[]>;
  practicePoints: number | null;
}

interface Attempt {
  id: string;
  source: string;
  language: string;
  verdict: string | null;
  failedTest: number | null;
}

const penaltyOf = (rows: { level: number; blockedReason: string | null }[]) =>
  Math.max(
    0,
    ...rows
      .filter((r) => r.blockedReason === null)
      .map((r) => HINT_PENALTY_PERCENT[r.level as HintLevel] ?? 0),
  );

/**
 * AI-02: the hint ladder (FR-AI-01..07, PRD §9.5). Practice only; level n+1 after level n; a delivered level
 * is returned again for free; the pipeline is sufficiency → main hint → code removal → deterministic filter
 * (regenerate once, else a safe generic hint); everything is logged in `hint_requests`.
 */
@Injectable()
export class HintsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AiRouter) private readonly router: AiRouter,
    @Inject(AiLedger) private readonly ledger: AiLedger,
    @Inject(AiCache) private readonly cache: AiCache,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  // ---- guards and lookups --------------------------------------------------------------------

  /** The problem, or 404. Existence is checked before the contest rule so a running contest answers 422, not 404. */
  private async target(slug: string): Promise<Target> {
    const [row] = await this.db
      .select({
        problemId: problems.id,
        slug: problems.slug,
        title: problems.title,
        versionId: problemVersions.id,
        statementMd: problemVersions.statementMd,
        editorialMd: problemVersions.editorialMd,
        avoidSet: problemVersions.avoidSet,
        practicePoints: problems.practicePoints,
      })
      .from(problems)
      .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
      .where(eq(problems.slug, slug))
      .limit(1);
    if (!row) throw new ProblemError('not-found', 'No such problem');
    return { ...row, avoidSet: row.avoidSet as Record<string, string[]> };
  }

  /** FR-CONT-08: a running contest that includes the problem switches hints off, for everyone. */
  private async inRunningContest(problemId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: contests.id })
      .from(contestProblems)
      .innerJoin(contests, eq(contests.id, contestProblems.contestId))
      .where(
        and(
          eq(contestProblems.problemId, problemId),
          ne(contests.status, 'draft'),
          lte(contests.startsAt, sql`now()`),
          gt(contests.endsAt, sql`now()`),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async visibleInPractice(problemId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: problems.id })
      .from(problems)
      .where(and(eq(problems.id, problemId), practiceVisible))
      .limit(1);
    return row !== undefined;
  }

  private async mine(userId: string, problemId: string) {
    return this.db
      .select()
      .from(hintRequests)
      .where(and(eq(hintRequests.userId, userId), eq(hintRequests.problemId, problemId)))
      .orderBy(desc(hintRequests.createdAt));
  }

  private async attempt(userId: string, t: Target, submissionId?: string): Promise<Attempt | null> {
    const cols = {
      id: submissions.id,
      source: submissions.source,
      language: submissions.language,
      verdict: submissions.verdict,
      failedTest: submissions.failedTest,
    };
    const base = and(eq(submissions.userId, userId), eq(problemVersions.problemId, t.problemId));
    const [row] = await this.db
      .select(cols)
      .from(submissions)
      .innerJoin(problemVersions, eq(problemVersions.id, submissions.problemVersionId))
      .where(submissionId ? and(base, eq(submissions.id, submissionId)) : base)
      .orderBy(desc(submissions.createdAt))
      .limit(1);
    if (submissionId && !row) throw new ProblemError('not-found', 'No such submission');
    return row ?? null;
  }

  // ---- state -----------------------------------------------------------------------------------

  async state(userId: string, slug: string): Promise<HintState> {
    const t = await this.target(slug);
    const running = await this.inRunningContest(t.problemId);
    if (!running && !(await this.visibleInPractice(t.problemId))) {
      throw new ProblemError('not-found', 'No such problem');
    }
    const rows = await this.mine(userId, t.problemId);
    const delivered = new Map<number, (typeof rows)[number]>();
    for (const r of rows)
      if (r.response !== null && !delivered.has(r.level)) delivered.set(r.level, r);
    const off = running
      ? "Hints are off during contests — they'll be back after it ends."
      : this.router.available
        ? null
        : 'Hints are not available right now.';
    const levels = ([1, 2, 3] as HintLevel[]).map((level): HintItem => {
      const r = delivered.get(level);
      return {
        level,
        status: r ? 'delivered' : level === 1 || delivered.has(level - 1) ? 'available' : 'locked',
        costPercent: HINT_PENALTY_PERCENT[level],
        hintId: r?.id ?? null,
        text: r?.response ?? null,
        helpful: r?.helpful ?? null,
      };
    });
    const pct = penaltyOf(rows.filter((r) => r.response !== null));
    const used = await this.ledger.count('user:hint', userId, 3600);
    return {
      enabled: off === null,
      disabledReason: off,
      levels,
      practicePoints: t.practicePoints,
      effectivePoints:
        t.practicePoints === null ? null : Math.round((t.practicePoints * (100 - pct)) / 100),
      penaltyPercent: pct,
      hasAttempt: (await this.attempt(userId, t)) !== null,
      remainingThisHour: Math.max(0, HINTS_PER_HOUR - used),
    };
  }

  // ---- request ---------------------------------------------------------------------------------

  async request(userId: string, body: CreateHint): Promise<HintResult> {
    return tracer.startActiveSpan('hints.request', async (span) => {
      span.setAttributes({ 'hint.level': body.level });
      try {
        const out = await this.run(userId, body);
        hintsTotal.add(1, {
          level: String(body.level),
          outcome: out.nudge
            ? 'nudge'
            : out.hint!.generic
              ? 'generic'
              : out.hint!.cached
                ? 'cached'
                : 'ok',
        });
        return out;
      } catch (err) {
        hintsTotal.add(1, {
          level: String(body.level),
          outcome: err instanceof ProblemError ? err.code : 'error',
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async run(userId: string, body: CreateHint): Promise<HintResult> {
    const level = body.level;
    const t = await this.target(body.problemSlug);
    if (await this.inRunningContest(t.problemId)) {
      throw new ProblemError(
        'hints-disabled-in-contest',
        "Hints are off during contests — they'll be back after it ends.",
      );
    }
    if (!(await this.visibleInPractice(t.problemId)))
      throw new ProblemError('not-found', 'No such problem');

    const rows = await this.mine(userId, t.problemId);
    const delivered = rows.filter((r) => r.response !== null);
    const have = delivered.find((r) => r.level === level);
    if (have) return this.asResult(have, delivered, true);
    if (level > 1 && !delivered.some((r) => r.level === level - 1)) {
      throw new ProblemError('hint-level-locked', `Unlock level ${level - 1} first`);
    }
    if (!this.router.available) throw new ProblemError('ai-busy', BUSY);

    const attempt = await this.attempt(userId, t, body.submissionId);
    if (level > 1 && !attempt) return { hint: null, nudge: DEFAULT_NUDGE };

    // A repeat of the same situation (same code, verdict, level, prompt) is served from the cache.
    const cacheKey = aiCacheKey(
      t.versionId,
      level,
      normaliseCode(attempt?.source ?? ''),
      `${attempt?.verdict ?? ''}:${attempt?.failedTest ?? ''}`,
      HINT_PROMPT_VERSION,
    );
    const cached = await this.cache.get<{ text: string }>(cacheKey);
    if (cached) {
      const row = await this.store(userId, t, level, attempt, {
        text: cached.text,
        generic: false,
        leak: false,
        blocked: null,
        models: ['cache'],
        tokensIn: 0,
        tokensOut: 0,
      });
      return this.asResult(row, [...delivered, row], true);
    }

    const lockKey = `hint:${userId}:${t.problemId}:${level}`;
    if (!(await this.ledger.tryLock(lockKey, 60))) {
      throw new ProblemError('rate-limited', 'This hint is already being written', {
        headers: { 'Retry-After': '5' },
      });
    }
    try {
      await this.router.guardUser('hint', userId, HINTS_PER_HOUR);
      const ctx: HintContext = {
        level,
        title: t.title,
        statement: t.statementMd,
        editorial: t.editorialMd,
        code: attempt?.source ?? null,
        language: attempt?.language ?? null,
        verdict: attempt?.verdict ?? null,
        failedTest: attempt?.failedTest ?? null,
      };
      const made = await this.pipeline(userId, ctx, t.avoidSet, Boolean(attempt));
      if (made.kind === 'nudge') return { hint: null, nudge: made.nudge };
      const row = await this.store(userId, t, level, attempt, made);
      if (!made.generic) await this.cache.set(cacheKey, { text: made.text }, 7 * 24 * 3600);
      await this.event(userId, 'hint_requested', { problemId: t.problemId, level });
      return this.asResult(row, [...delivered, row], false);
    } finally {
      await this.ledger.unlock(lockKey);
    }
  }

  // ---- the pipeline (SD-§12.2) -----------------------------------------------------------------

  private async pipeline(
    userId: string,
    ctx: HintContext,
    avoidSet: Record<string, string[]>,
    hasCode: boolean,
  ) {
    const models: string[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    const call = async (
      task: 'sufficiency' | 'hint_main' | 'code_removal',
      messages: HintMessages,
      maxTokens: number,
      json = false,
    ) => {
      const r = await this.router.complete({
        task,
        feature: 'hint',
        messages,
        maxTokens,
        temperature: task === 'hint_main' ? 0.3 : 0,
        json,
      });
      models.push(`${task}=${r.model}`);
      tokensIn += r.usage.inputTokens;
      tokensOut += r.usage.outputTokens;
      return r.text.trim();
    };

    // 1. sufficiency (only when there is code to judge)
    if (hasCode) {
      const verdict = parseSufficiency(
        await call('sufficiency', SUFFICIENCY.render(ctx), 120, true),
      );
      if (!verdict.sufficient) {
        const nudge =
          verdict.nudge && filterHint(verdict.nudge, ctx.level, avoidSet).ok
            ? verdict.nudge.slice(0, 300)
            : DEFAULT_NUDGE;
        return { kind: 'nudge' as const, nudge };
      }
    }

    let leak = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      // 2. main hint, 3. code-removal rewrite (always, independent of the main model behaving)
      const main = await call('hint_main', HINT_MAIN.render({ ...ctx, strict: attempt > 0 }), 350);
      if (attempt === 0) leak = !filterHint(main, ctx.level, avoidSet).ok;
      const cleaned = await call('code_removal', CODE_REMOVAL.render({ hint: main }), 350);
      // 4. deterministic filter
      const f = filterHint(cleaned, ctx.level, avoidSet);
      if (f.ok && cleaned.length > 0) {
        return {
          kind: 'hint' as const,
          text: cleaned,
          generic: false,
          leak,
          blocked: null as string | null,
          models,
          tokensIn,
          tokensOut,
        };
      }
      this.log.warn(
        { userId, level: ctx.level, reasons: f.reasons, attempt },
        'hint blocked by the filter',
      );
    }
    return {
      kind: 'hint' as const,
      text: GENERIC_HINTS[ctx.level],
      generic: true,
      leak,
      blocked: 'filter' as string | null,
      models,
      tokensIn,
      tokensOut,
    };
  }

  // ---- storage ---------------------------------------------------------------------------------

  private async store(
    userId: string,
    t: Target,
    level: HintLevel,
    attempt: Attempt | null,
    m: {
      text: string;
      generic: boolean;
      leak: boolean;
      blocked: string | null;
      models: string[];
      tokensIn: number;
      tokensOut: number;
    },
  ) {
    const [row] = await this.db
      .insert(hintRequests)
      .values({
        userId,
        problemId: t.problemId,
        level,
        submissionId: attempt?.id ?? null,
        promptVersion: HINT_PROMPT_VERSION,
        models: m.models,
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
        response: m.text,
        leakFlag: m.leak,
        blockedReason: m.blocked,
      })
      .returning();
    return row!;
  }

  private asResult(
    row: typeof hintRequests.$inferSelect,
    delivered: { level: number; blockedReason: string | null }[],
    cached: boolean,
  ): HintResult {
    return {
      hint: {
        id: row.id,
        level: row.level as HintLevel,
        text: row.response ?? '',
        penaltyPercent: penaltyOf(delivered),
        cached,
        generic: row.blockedReason !== null,
      },
      nudge: null,
    };
  }

  // ---- rating (FR-AI-05) -----------------------------------------------------------------------

  async rate(userId: string, hintId: string, helpful: boolean) {
    const updated = await this.db
      .update(hintRequests)
      .set({ helpful })
      .where(and(eq(hintRequests.id, hintId), eq(hintRequests.userId, userId)))
      .returning({ id: hintRequests.id, level: hintRequests.level });
    if (updated.length === 0) throw new ProblemError('not-found', 'No such hint');
    await this.event(userId, 'hint_rated', { hintId, helpful });
  }

  private async event(userId: string, name: string, props: Record<string, unknown>) {
    await this.db
      .insert(productEvents)
      .values({ userId, name, props })
      .catch(() => {});
  }
}

type HintMessages = ReturnType<typeof SUFFICIENCY.render>;

/** The sufficiency model answers JSON; anything unreadable counts as "sufficient" (the later steps and the filter still guard). */
export function parseSufficiency(raw: string): { sufficient: boolean; nudge: string } {
  const body = raw.replace(/^```(?:json)?|```$/gm, '').trim();
  try {
    const v = JSON.parse(body) as { sufficient?: unknown; nudge?: unknown };
    return {
      sufficient: v.sufficient !== false,
      nudge: typeof v.nudge === 'string' ? v.nudge.trim() : '',
    };
  } catch {
    return { sufficient: true, nudge: '' };
  }
}
