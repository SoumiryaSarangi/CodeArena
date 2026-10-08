import type { S3Client } from '@aws-sdk/client-s3';
import type {
  AdminProblemDetail,
  AdminProblemList,
  StatementPatch,
  TestsList,
  UploadResult,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { asc, desc, eq } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import {
  packageSolutions,
  problemTags,
  problemVersions,
  problems,
  validationRuns,
} from '../../db/schema';
import { S3 } from '../../s3/s3.module';
import type { AuthUser } from '../auth/guards';
import { assertCanManage } from '../problems/access';
import { ObjectError, readObject } from '../problems/objects';
import {
  MAX_PACKAGE_BYTES,
  checkStatement,
  parsePackage,
  type PackageFiles,
} from '../problems/package';
import { ProblemImporter, type Visibility } from '../problems/problems.import';
import { readTestset } from '../problems/testset';

const tracer = trace.getTracer('api');
const actions = metrics.getMeter('api').createCounter('ca_admin_problem_actions_total', {
  description: 'Setter/admin problem actions, by action and outcome',
});

type User = Pick<AuthUser, 'id' | 'role'>;
/** Large enough for 99 tests of 50 MB in total plus headers. */
const MAX_TESTSET_BYTES = 60 * 1024 * 1024;

/** Only these package files matter; everything else a folder holds (generators, notes) is left out. */
const PACKAGE_PATH =
  /^(problem\.yaml|statement\.md|editorial\.md|validator\.cpp|checker\.cpp|tests\/[^/]+|solutions\/[^/]+)$/;

export interface UploadedPart {
  /** The package-relative path (the multipart field name). */
  fieldname: string;
  buffer: Buffer;
}

/** Turns the multipart parts of a folder upload into package files, refusing odd paths. */
export function toPackageFiles(slug: string, parts: UploadedPart[]): PackageFiles {
  const errors: { path: string; message: string }[] = [];
  const raw = parts.map((p) => ({ path: p.fieldname, buffer: p.buffer }));
  // A dragged folder arrives as `<slug>/problem.yaml`...: drop the folder name.
  const strip = raw.length > 0 && raw.every((p) => p.path.startsWith(`${slug}/`));
  const files: PackageFiles = new Map();
  let total = 0;
  for (const p of raw) {
    const path = strip ? p.path.slice(slug.length + 1) : p.path;
    const segments = path.split('/');
    if (
      path.length === 0 ||
      path.length > 200 ||
      path.includes('\\') ||
      path.startsWith('/') ||
      segments.some((s) => s === '' || s === '.' || s === '..')
    ) {
      errors.push({ path: p.path.slice(0, 200), message: 'not a valid package-relative path' });
      continue;
    }
    if (!PACKAGE_PATH.test(path)) continue;
    if (files.has(path)) {
      errors.push({ path, message: `${path} was sent twice` });
      continue;
    }
    total += p.buffer.length;
    files.set(path, p.buffer);
  }
  if (total > MAX_PACKAGE_BYTES)
    throw new ProblemError('payload-too-large', 'The package is larger than 100 MB');
  if (errors.length > 0) {
    throw new ProblemError('invalid-package', `The upload has ${errors.length} unusable file(s)`, {
      errors,
    });
  }
  return files;
}

@Injectable()
export class AdminProblemsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(ProblemImporter) private readonly importer: ProblemImporter,
  ) {}

  private async traced<T>(action: string, fn: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(`admin.${action}`, async (span) => {
      try {
        const out = await fn();
        actions.add(1, { action, outcome: 'ok' });
        return out;
      } catch (err) {
        actions.add(1, { action, outcome: err instanceof ProblemError ? err.code : 'error' });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async list(user: User): Promise<AdminProblemList> {
    return this.traced('list', async () => {
      const rows = await this.db
        .select({ p: problems, v: problemVersions })
        .from(problems)
        .leftJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
        .where(user.role === 'admin' ? undefined : eq(problems.authorId, user.id))
        .orderBy(asc(problems.slug));
      return {
        items: rows.map(({ p, v }) => ({
          slug: p.slug,
          title: p.title,
          difficulty: p.difficulty,
          visibility: p.visibility,
          version: v?.version ?? null,
          testsCount: v?.testsCount ?? 0,
          validationStatus: v?.validationStatus ?? null,
          updatedAt: v?.createdAt.toISOString() ?? null,
          mine: p.authorId === user.id,
        })),
      };
    });
  }

  private async problemBySlug(slug: string, user: User) {
    const [problem] = await this.db.select().from(problems).where(eq(problems.slug, slug)).limit(1);
    if (!problem) throw new ProblemError('not-found');
    assertCanManage(user, problem.authorId);
    return problem;
  }

  async get(slug: string, user: User): Promise<AdminProblemDetail> {
    return this.traced('get', async () => {
      const problem = await this.problemBySlug(slug, user);
      const versions = await this.db
        .select()
        .from(problemVersions)
        .where(eq(problemVersions.problemId, problem.id))
        .orderBy(desc(problemVersions.version));
      const tags = await this.db
        .select({ tag: problemTags.tag })
        .from(problemTags)
        .where(eq(problemTags.problemId, problem.id))
        .orderBy(asc(problemTags.tag));
      const current = versions.find((v) => v.id === problem.currentVersionId) ?? versions[0];
      let detail: AdminProblemDetail['current'] = null;
      if (current) {
        const solutions = await this.db
          .select()
          .from(packageSolutions)
          .where(eq(packageSolutions.versionId, current.id))
          .orderBy(asc(packageSolutions.name));
        const checker = current.checker as {
          kind: 'exact' | 'tokens' | 'float' | 'testlib';
          eps?: number;
        };
        detail = {
          id: current.id,
          version: current.version,
          statementMd: current.statementMd,
          editorialMd: current.editorialMd ?? '',
          limits: current.limits as { timeMs: number; memMb: number; outputKb: number },
          checker: {
            kind: checker.kind,
            ...(checker.eps === undefined ? {} : { eps: checker.eps }),
          },
          samples: (current.samples as unknown[]).length,
          solutions: solutions.map((s) => ({
            name: s.name,
            language: s.language,
            expected: s.expectedVerdict,
          })),
          validatorStored: current.validatorUri !== null,
          lastRun: await this.lastRun(current.id),
        };
      }
      return {
        slug: problem.slug,
        title: problem.title,
        difficulty: problem.difficulty,
        tags: tags.map((t) => t.tag),
        practicePoints: problem.practicePoints,
        visibility: problem.visibility,
        mine: problem.authorId === user.id,
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          createdAt: v.createdAt.toISOString(),
          testsCount: v.testsCount,
          testsetHash: v.testsetHash,
          validationStatus: v.validationStatus,
          validatedAt: v.validatedAt?.toISOString() ?? null,
        })),
        current: detail,
      };
    });
  }

  private async lastRun(versionId: string) {
    const [run] = await this.db
      .select()
      .from(validationRuns)
      .where(eq(validationRuns.versionId, versionId))
      .orderBy(desc(validationRuns.createdAt))
      .limit(1);
    if (!run) return null;
    const finished = run.status === 'done' || run.status === 'failed';
    return {
      id: run.id,
      status: run.status,
      ok: finished ? ((run.results as { ok?: boolean } | null)?.ok ?? false) : null,
      createdAt: run.createdAt.toISOString(),
    };
  }

  /** FR-PROB-01..03: a package folder becomes a new problem (private) or a new version of one. */
  async upload(slug: string, files: PackageFiles, user: User): Promise<UploadResult> {
    return this.traced('upload', async () => {
      const [existing] = await this.db
        .select({ authorId: problems.authorId })
        .from(problems)
        .where(eq(problems.slug, slug))
        .limit(1);
      if (existing) assertCanManage(user, existing.authorId);
      const parsed = parsePackage(slug, files);
      if (!parsed.ok) {
        throw new ProblemError(
          'invalid-package',
          `The package has ${parsed.errors.length} problem(s)`,
          {
            errors: parsed.errors,
          },
        );
      }
      const r = await this.importer.import(parsed.pkg, { actorId: user.id });
      return {
        outcome: r.outcome,
        slug,
        versionId: r.versionId,
        version: r.version,
        testsCount: r.testsCount,
      };
    });
  }

  /** FR-PROB-02: an edited statement or editorial is a new immutable version; tests are untouched. */
  async patchStatement(slug: string, body: StatementPatch, user: User): Promise<UploadResult> {
    return this.traced('statement', async () => {
      const messages = checkStatement(body.statementMd);
      if (messages.length > 0) {
        throw new ProblemError('validation', 'The statement does not follow the format', {
          errors: messages.map((message) => ({ path: 'statementMd', message })),
        });
      }
      const problem = await this.problemBySlug(slug, user);
      return this.db.transaction(async (tx) => {
        await tx
          .select({ id: problems.id })
          .from(problems)
          .where(eq(problems.id, problem.id))
          .for('update');
        const [last] = await tx
          .select()
          .from(problemVersions)
          .where(eq(problemVersions.problemId, problem.id))
          .orderBy(desc(problemVersions.version))
          .limit(1);
        if (!last) throw new ProblemError('not-found', 'This problem has no version yet');
        if (
          last.statementMd === body.statementMd &&
          (last.editorialMd ?? '') === body.editorialMd
        ) {
          return {
            outcome: 'unchanged' as const,
            slug,
            versionId: last.id,
            version: last.version,
            testsCount: last.testsCount,
          };
        }
        const [row] = await tx
          .insert(problemVersions)
          .values({
            problemId: problem.id,
            version: last.version + 1,
            statementMd: body.statementMd,
            editorialMd: body.editorialMd,
            limits: last.limits,
            checker: last.checker,
            testsetHash: last.testsetHash,
            testsetUri: last.testsetUri,
            validatorUri: last.validatorUri,
            testsCount: last.testsCount,
            samples: last.samples,
            avoidSet: last.avoidSet,
            // Same tests, solutions, limits and checker: whatever was proved still holds.
            validationStatus:
              last.validationStatus === 'running' ? 'pending' : last.validationStatus,
            validatedAt: last.validatedAt,
            createdBy: user.id,
          })
          .returning({ id: problemVersions.id });
        const sols = await tx
          .select()
          .from(packageSolutions)
          .where(eq(packageSolutions.versionId, last.id));
        if (sols.length > 0) {
          await tx.insert(packageSolutions).values(
            sols.map((s) => ({
              versionId: row!.id,
              name: s.name,
              language: s.language,
              expectedVerdict: s.expectedVerdict,
              sourceUri: s.sourceUri,
            })),
          );
        }
        await tx
          .update(problems)
          .set({ currentVersionId: row!.id })
          .where(eq(problems.id, problem.id));
        return {
          outcome: 'new-version' as const,
          slug,
          versionId: row!.id,
          version: last.version + 1,
          testsCount: last.testsCount,
        };
      });
    });
  }

  /** Admin only (the route says so): who can see a problem is a policy decision. */
  async setVisibility(
    slug: string,
    visibility: Visibility,
  ): Promise<{ slug: string; visibility: Visibility }> {
    return this.traced('visibility', async () => {
      const updated = await this.db
        .update(problems)
        .set({ visibility })
        .where(eq(problems.slug, slug))
        .returning({ slug: problems.slug });
      if (updated.length === 0) throw new ProblemError('not-found');
      return { slug, visibility };
    });
  }

  private async versionFor(versionId: string, user: User) {
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new ProblemError('not-found');
    const [row] = await this.db
      .select({ v: problemVersions, authorId: problems.authorId })
      .from(problemVersions)
      .innerJoin(problems, eq(problems.id, problemVersions.problemId))
      .where(eq(problemVersions.id, versionId))
      .limit(1);
    if (!row) throw new ProblemError('not-found');
    assertCanManage(user, row.authorId);
    return row.v;
  }

  private async archive(version: { testsetUri: string | null }): Promise<Buffer> {
    if (!version.testsetUri) throw new ProblemError('not-found', 'This version has no tests');
    try {
      return await readObject(
        this.s3,
        this.config,
        version.testsetUri,
        'testsets/',
        MAX_TESTSET_BYTES,
      );
    } catch (err) {
      if (err instanceof ObjectError)
        throw new ProblemError('not-found', 'The tests are not available');
      throw err;
    }
  }

  async tests(versionId: string, user: User): Promise<TestsList> {
    return this.traced('tests', async () => {
      const version = await this.versionFor(versionId, user);
      const files = readTestset(await this.archive(version));
      const samples = (version.samples as unknown[]).length;
      const items: TestsList['items'] = [];
      for (const [name, body] of files) {
        const m = /^([0-9]{2})\.in$/.exec(name);
        if (!m) continue;
        const no = Number(m[1]);
        items.push({
          no,
          inBytes: body.length,
          ansBytes: files.get(`${m[1]}.ans`)?.length ?? 0,
          sample: no <= samples,
        });
      }
      return { items: items.sort((a, b) => a.no - b.no) };
    });
  }

  /** FR-PROB-06: tests leave the server only here, for the problem's setter or an admin. */
  async testFile(versionId: string, file: string, user: User): Promise<Buffer> {
    return this.traced('test-file', async () => {
      if (!/^[0-9]{2}\.(in|ans)$/.test(file)) throw new ProblemError('not-found');
      const version = await this.versionFor(versionId, user);
      const body = readTestset(await this.archive(version)).get(file);
      if (!body) throw new ProblemError('not-found');
      return body;
    });
  }

  async testsArchive(versionId: string, user: User): Promise<Buffer> {
    return this.traced('tests-archive', async () =>
      this.archive(await this.versionFor(versionId, user)),
    );
  }
}
