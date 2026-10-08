import {
  ContestRules,
  type AdminContestDetail,
  type AdminContestList,
  type BoardSnapshot,
  type ContestCreate,
  type ContestDetail,
  type ContestList,
  type ContestPatch,
  type ContestProblemDetail,
  type ContestProblemList,
  type ContestProblemsPut,
  type ContestSummary,
  type Role,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import {
  contestProblems,
  contests,
  participants,
  problemVersions,
  problems,
} from '../../db/schema';
import { BoardService } from '../board/board.service';
import { contestState } from './state';

const tracer = trace.getTracer('api');
const registrations = metrics.getMeter('api').createCounter('ca_contest_registrations_total', {
  description: 'Contest registrations, by outcome',
});
const actions = metrics.getMeter('api').createCounter('ca_contest_admin_actions_total', {
  description: 'Admin contest actions, by action',
});

export interface Viewer {
  id: string;
  role: Role;
}

type Row = typeof contests.$inferSelect;
const iso = (d: Date) => d.toISOString();

const invalid = (path: string, message: string) =>
  new ProblemError('validation', message, { errors: [{ path, message }] });

@Injectable()
export class ContestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BoardService) private readonly board: BoardService,
  ) {}

  /** The server's clock, read once per request so every field of a response agrees. */
  private now() {
    return new Date();
  }

  private async bySlug(slug: string, viewer?: Viewer): Promise<Row> {
    const [row] = await this.db.select().from(contests).where(eq(contests.slug, slug)).limit(1);
    // A draft does not exist for anyone but an admin (it reveals nothing about its problems).
    if (!row || (row.status === 'draft' && viewer?.role !== 'admin')) {
      throw new ProblemError('not-found', 'No such contest');
    }
    return row;
  }

  private counts(ids: string[]) {
    if (ids.length === 0)
      return Promise.resolve(new Map<string, { problems: number; reg: number }>());
    return this.db
      .execute<{ id: string; problems: number; reg: number }>(
        sql`select c.id,
          (select count(*)::int from ${contestProblems} cp where cp.contest_id = c.id) as problems,
          (select count(*)::int from ${participants} p where p.contest_id = c.id) as reg
        from ${contests} c where c.id in (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      )
      .then((r) => new Map(r.rows.map((x) => [x.id, x])));
  }

  private async registeredSet(ids: string[], userId?: string) {
    if (!userId || ids.length === 0) return new Set<string>();
    const rows = await this.db
      .select({ id: participants.contestId })
      .from(participants)
      .where(and(eq(participants.userId, userId), inArray(participants.contestId, ids)));
    return new Set(rows.map((r) => r.id));
  }

  private summary(
    c: Row,
    now: Date,
    n: { problems: number; reg: number } | undefined,
    registered: boolean,
  ): ContestSummary {
    return {
      slug: c.slug,
      title: c.title,
      state: contestState(c, now),
      startsAt: iso(c.startsAt),
      endsAt: iso(c.endsAt),
      freezeAt: c.freezeAt ? iso(c.freezeAt) : null,
      problemCount: n?.problems ?? 0,
      registeredCount: n?.reg ?? 0,
      registered,
    };
  }

  /** FR-CONT-02: until the contest ends, unless late registration is off (then until it starts). */
  private canRegister(c: Row, now: Date) {
    const state = contestState(c, now);
    const rules = ContestRules.parse(c.rules);
    if (state === 'scheduled') return true;
    return state === 'running' && rules.lateRegistration;
  }

  private detailOf(
    c: Row,
    now: Date,
    n: { problems: number; reg: number } | undefined,
    registered: boolean,
  ): ContestDetail {
    return {
      ...this.summary(c, now, n, registered),
      description: c.description,
      rules: ContestRules.parse(c.rules),
      serverNow: iso(now),
      canRegister: !registered && this.canRegister(c, now),
    };
  }

  /** Published contests, newest start first (GET /contests). */
  async list(viewer?: Viewer): Promise<ContestList> {
    const now = this.now();
    const rows = await this.db
      .select()
      .from(contests)
      .where(sql`${contests.status} <> 'draft'`)
      .orderBy(desc(contests.startsAt))
      .limit(100);
    const ids = rows.map((r) => r.id);
    const [n, mine] = await Promise.all([this.counts(ids), this.registeredSet(ids, viewer?.id)]);
    return {
      serverNow: iso(now),
      items: rows.map((r) => this.summary(r, now, n.get(r.id), mine.has(r.id))),
    };
  }

  async detail(slug: string, viewer?: Viewer): Promise<ContestDetail> {
    const now = this.now();
    const c = await this.bySlug(slug, viewer);
    const [n, mine] = await Promise.all([
      this.counts([c.id]),
      this.registeredSet([c.id], viewer?.id),
    ]);
    return this.detailOf(c, now, n.get(c.id), mine.has(c.id));
  }

  /** US-4.1 / FR-CONT-02. 409 `already-registered` on a repeat. */
  async register(slug: string, userId: string): Promise<ContestDetail> {
    return tracer.startActiveSpan('contests.register', async (span) => {
      try {
        const now = this.now();
        const c = await this.bySlug(slug);
        span.setAttribute('contest.id', c.id);
        const state = contestState(c, now);
        if (state === 'ended' || state === 'finalized') {
          registrations.add(1, { outcome: 'ended' });
          throw new ProblemError('contest-ended', 'This contest has ended');
        }
        if (!this.canRegister(c, now)) {
          registrations.add(1, { outcome: 'closed' });
          throw new ProblemError('forbidden', 'Registration closed when the contest started');
        }
        const inserted = await this.db
          .insert(participants)
          .values({ contestId: c.id, userId })
          .onConflictDoNothing()
          .returning({ userId: participants.userId });
        if (inserted.length === 0) {
          registrations.add(1, { outcome: 'duplicate' });
          throw new ProblemError('already-registered', 'You are already registered');
        }
        registrations.add(1, { outcome: 'ok' });
        await this.board.addParticipant(c.id, userId);
        const n = await this.counts([c.id]);
        return this.detailOf(c, now, n.get(c.id), true);
      } finally {
        span.end();
      }
    });
  }

  /**
   * FR-PROB-09: who may read a contest's problems. Staff (setter, admin) any time; a registered
   * contestant while it runs; anyone once it has ended. Before the start everyone else gets 404
   * so a hidden problem does not even reveal that it exists.
   */
  private async gate(c: Row, now: Date, viewer?: Viewer) {
    const state = contestState(c, now);
    if (state === 'ended' || state === 'finalized') return;
    if (viewer?.role === 'admin' || viewer?.role === 'setter') return;
    if (state === 'scheduled' || state === 'draft') {
      throw new ProblemError('not-found', 'No such contest');
    }
    const mine = await this.registeredSet([c.id], viewer?.id);
    if (!mine.has(c.id)) {
      throw new ProblemError('forbidden', 'Register for the contest to see its problems');
    }
  }

  private problemRows(contestId: string) {
    return this.db
      .select({
        label: contestProblems.label,
        slug: problems.slug,
        title: problems.title,
        difficulty: problems.difficulty,
        limits: problemVersions.limits,
        statementMd: problemVersions.statementMd,
        samples: problemVersions.samples,
        testsCount: problemVersions.testsCount,
        checker: problemVersions.checker,
      })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .innerJoin(problemVersions, eq(problemVersions.id, contestProblems.versionId))
      .where(eq(contestProblems.contestId, contestId))
      .orderBy(asc(contestProblems.position));
  }

  async problems(slug: string, viewer?: Viewer): Promise<ContestProblemList> {
    const now = this.now();
    const c = await this.bySlug(slug, viewer);
    await this.gate(c, now, viewer);
    const rows = await this.problemRows(c.id);
    return {
      serverNow: iso(now),
      items: rows.map((r) => ({
        label: r.label,
        title: r.title,
        slug: r.slug,
        difficulty: r.difficulty,
        limits: r.limits as ContestProblemDetail['limits'],
      })),
    };
  }

  async problem(slug: string, label: string, viewer?: Viewer): Promise<ContestProblemDetail> {
    const now = this.now();
    const c = await this.bySlug(slug, viewer);
    await this.gate(c, now, viewer);
    const r = (await this.problemRows(c.id)).find((x) => x.label === label);
    if (!r) throw new ProblemError('not-found', 'No such problem');
    return {
      label: r.label,
      title: r.title,
      slug: r.slug,
      difficulty: r.difficulty,
      limits: r.limits as ContestProblemDetail['limits'],
      statementMd: r.statementMd,
      samples: r.samples as ContestProblemDetail['samples'],
      testsCount: r.testsCount,
      // The checker's source location stays server-side (FR-PROB-06).
      checker:
        (r.checker as { eps?: number }).eps === undefined
          ? { kind: (r.checker as { kind: ContestProblemDetail['checker']['kind'] }).kind }
          : {
              kind: (r.checker as { kind: ContestProblemDetail['checker']['kind'] }).kind,
              eps: (r.checker as { eps: number }).eps,
            },
    };
  }

  /** GET /contests/{slug}/board (C-02): public once published; frozen view per FR-BOARD-05. */
  async boardOf(slug: string, viewer?: Viewer): Promise<BoardSnapshot> {
    const c = await this.bySlug(slug, viewer);
    return this.board.snapshot(c, viewer);
  }

  /** POST /admin/contests/{id}/rebuild-board (FR-BOARD-08). */
  async rebuildBoard(id: string): Promise<{ version: number }> {
    const c = await this.byId(id);
    actions.add(1, { action: 'rebuild-board' });
    return { version: await this.board.rebuild(c.id, 'admin') };
  }

  // ----- admin (FR-CONT-01) -----

  async adminList(): Promise<AdminContestList> {
    const now = this.now();
    const rows = await this.db.select().from(contests).orderBy(desc(contests.startsAt)).limit(200);
    const n = await this.counts(rows.map((r) => r.id));
    return {
      serverNow: iso(now),
      items: rows.map((r) => ({ id: r.id, ...this.summary(r, now, n.get(r.id), false) })),
    };
  }

  private async byId(id: string): Promise<Row> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ProblemError('not-found', 'No such contest');
    const [row] = await this.db.select().from(contests).where(eq(contests.id, id)).limit(1);
    if (!row) throw new ProblemError('not-found', 'No such contest');
    return row;
  }

  async adminGet(id: string): Promise<AdminContestDetail> {
    const now = this.now();
    const c = await this.byId(id);
    const n = await this.counts([c.id]);
    const rows = await this.db
      .select({
        label: contestProblems.label,
        slug: problems.slug,
        title: problems.title,
        version: problemVersions.version,
        validationStatus: problemVersions.validationStatus,
      })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .innerJoin(problemVersions, eq(problemVersions.id, contestProblems.versionId))
      .where(eq(contestProblems.contestId, c.id))
      .orderBy(asc(contestProblems.position));
    return { id: c.id, ...this.detailOf(c, now, n.get(c.id), false), problems: rows };
  }

  async create(body: ContestCreate, adminId: string): Promise<AdminContestDetail> {
    return tracer.startActiveSpan('contests.create', async (span) => {
      try {
        const [row] = await this.db
          .insert(contests)
          .values({
            slug: body.slug,
            title: body.title,
            description: body.description,
            startsAt: new Date(body.startsAt),
            endsAt: new Date(body.endsAt),
            freezeAt: body.freezeAt ? new Date(body.freezeAt) : null,
            rules: body.rules,
            status: 'draft',
            createdBy: adminId,
          })
          .onConflictDoNothing({ target: contests.slug })
          .returning({ id: contests.id });
        if (!row) throw invalid('slug', 'A contest with this slug already exists');
        actions.add(1, { action: 'create' });
        return this.adminGet(row.id);
      } finally {
        span.end();
      }
    });
  }

  async patch(id: string, body: ContestPatch): Promise<AdminContestDetail> {
    return tracer.startActiveSpan('contests.patch', async (span) => {
      try {
        const c = await this.byId(id);
        const state = contestState(c, this.now());
        const live = state === 'running' || state === 'ended' || state === 'finalized';
        const set: Partial<typeof contests.$inferInsert> = {};
        if (body.title !== undefined) set.title = body.title;
        if (body.description !== undefined) set.description = body.description;
        if (body.startsAt !== undefined) {
          if (live) throw invalid('startsAt', 'The start cannot change once the contest has begun');
          set.startsAt = new Date(body.startsAt);
        }
        if (body.endsAt !== undefined) set.endsAt = new Date(body.endsAt);
        if (body.freezeAt !== undefined)
          set.freezeAt = body.freezeAt ? new Date(body.freezeAt) : null;
        if (body.rules !== undefined) {
          if (live) throw invalid('rules', 'Rules cannot change once the contest has begun');
          set.rules = ContestRules.parse({ ...ContestRules.parse(c.rules), ...body.rules });
        }
        // Cross-field time rules need the stored values too (a patch may send only one field).
        const s = set.startsAt ?? c.startsAt;
        const e = set.endsAt ?? c.endsAt;
        const f = set.freezeAt === undefined ? c.freezeAt : set.freezeAt;
        if (e <= s) throw invalid('endsAt', 'The end must be after the start');
        if (f && (f < s || f >= e))
          throw invalid('freezeAt', 'The freeze must be between start and end');
        if (body.published === true && c.status === 'draft') {
          await this.assertPublishable(c.id);
          set.status = 'scheduled';
        } else if (body.published === false && c.status !== 'draft') {
          if (live) throw invalid('published', 'A contest that has begun cannot go back to draft');
          set.status = 'draft';
        }
        if (Object.keys(set).length > 0) {
          await this.db.update(contests).set(set).where(eq(contests.id, c.id));
        }
        actions.add(1, { action: body.published === undefined ? 'edit' : 'publish' });
        return this.adminGet(c.id);
      } finally {
        span.end();
      }
    });
  }

  /** FR-PROB-05: only validated versions may be attached to a published contest. */
  private async assertPublishable(contestId: string) {
    const rows = await this.db
      .select({ slug: problems.slug, status: problemVersions.validationStatus })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .innerJoin(problemVersions, eq(problemVersions.id, contestProblems.versionId))
      .where(eq(contestProblems.contestId, contestId));
    if (rows.length === 0) throw invalid('published', 'Add at least one problem before publishing');
    const bad = rows.filter((r) => r.status !== 'passed');
    if (bad.length > 0) {
      throw new ProblemError('validation', 'Every problem version must pass validation first', {
        errors: bad.map((r) => ({
          path: `problems.${r.slug}`,
          message: `validation is ${r.status}; run Validate in the problem setter`,
        })),
      });
    }
  }

  /** PUT /admin/contests/{id}/problems: pins each problem's *current* version. */
  async putProblems(id: string, body: ContestProblemsPut): Promise<AdminContestDetail> {
    return tracer.startActiveSpan('contests.problems', async (span) => {
      try {
        const c = await this.byId(id);
        const state = contestState(c, this.now());
        if (state !== 'draft' && state !== 'scheduled') {
          throw invalid('items', 'The problem list is fixed once the contest has begun');
        }
        const found = body.items.length
          ? await this.db
              .select({
                id: problems.id,
                slug: problems.slug,
                versionId: problems.currentVersionId,
                status: problemVersions.validationStatus,
              })
              .from(problems)
              .leftJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
              .where(
                inArray(
                  problems.slug,
                  body.items.map((i) => i.slug),
                ),
              )
          : [];
        const errors: { path: string; message: string }[] = [];
        for (const [i, it] of body.items.entries()) {
          const p = found.find((f) => f.slug === it.slug);
          if (!p || !p.versionId) {
            errors.push({
              path: `items.${i}.slug`,
              message: `no problem "${it.slug}" with a version`,
            });
          } else if (c.status !== 'draft' && p.status !== 'passed') {
            errors.push({
              path: `items.${i}.slug`,
              message: `"${it.slug}" has not passed validation (it is ${p.status})`,
            });
          }
        }
        if (errors.length > 0) {
          throw new ProblemError('validation', 'Some problems cannot be used', { errors });
        }
        await this.db.transaction(async (tx) => {
          await tx.delete(contestProblems).where(eq(contestProblems.contestId, c.id));
          if (body.items.length === 0) return;
          await tx.insert(contestProblems).values(
            [...body.items]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((it, position) => {
                const p = found.find((f) => f.slug === it.slug)!;
                return {
                  contestId: c.id,
                  label: it.label,
                  problemId: p.id,
                  versionId: p.versionId!,
                  position,
                };
              }),
          );
        });
        actions.add(1, { action: 'problems' });
        return this.adminGet(c.id);
      } finally {
        span.end();
      }
    });
  }
}
