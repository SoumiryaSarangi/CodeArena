import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Verdict } from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { eq, sql } from 'drizzle-orm';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { packageSolutions, problemTags, problemVersions, problems } from '../../db/schema';
import { S3 } from '../../s3/s3.module';
import type { ProblemPackage } from './package';
import { buildTestset } from './testset';

const tracer = trace.getTracer('api');
const imports = metrics.getMeter('api').createCounter('ca_problem_imports_total', {
  description: 'Problem package imports, by outcome (created, new-version, unchanged)',
});

export type Visibility = 'public' | 'contest' | 'private';

export interface ImportResult {
  outcome: 'created' | 'new-version' | 'unchanged';
  problemId: string;
  versionId: string;
  version: number;
  testsetHash: string;
  testsCount: number;
}

const sortedSolutions = <T extends { name: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name));

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

@Injectable()
export class ProblemImporter {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Stores a structurally valid package (FR-PROB-01..03): tests go to object storage under their
   * content hash, then one transaction creates the problem (or a new immutable version of it,
   * FR-PROB-02). Re-importing identical content changes nothing. A new version starts with
   * validation `pending`; `visibility` applies only when given (a new problem is `private`).
   */
  async import(
    pkg: ProblemPackage,
    opts: { actorId?: string | null; visibility?: Visibility } = {},
  ): Promise<ImportResult> {
    return tracer.startActiveSpan('problems.import', async (span) => {
      span.setAttribute('problem.slug', pkg.slug);
      try {
        const result = await this.run(pkg, opts);
        imports.add(1, { outcome: result.outcome });
        span.setAttribute('outcome', result.outcome);
        return result;
      } catch (err) {
        imports.add(1, { outcome: 'error' });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private uri(key: string) {
    return `s3://${this.config.S3_BUCKET_TESTS}/${key}`;
  }

  /** Content-addressed, so an upload that is later abandoned is harmless and a repeat is skipped. */
  private async put(key: string, body: Buffer, contentType: string) {
    const bucket = this.config.S3_BUCKET_TESTS;
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw err;
    }
    await this.s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  private async run(
    pkg: ProblemPackage,
    opts: { actorId?: string | null; visibility?: Visibility },
  ): Promise<ImportResult> {
    const { data: tar, hash } = buildTestset(pkg.tests);
    const testsetKey = `testsets/${hash}.tar`;
    await this.put(testsetKey, tar, 'application/x-tar');

    let checker: { kind: string; eps?: number; sourceUri?: string } = { ...pkg.checker };
    if (pkg.checkerSource) {
      const key = `checkers/${sha256(pkg.checkerSource)}.cpp`;
      await this.put(key, pkg.checkerSource, 'text/x-c++src');
      checker = { kind: 'testlib', sourceUri: this.uri(key) };
    }
    // The validator is stored so a validation run can send it to a judge (FR-PROB-04, UI-04).
    const validatorKey = `validators/${sha256(pkg.validatorSource)}.cpp`;
    await this.put(validatorKey, pkg.validatorSource, 'text/x-c++src');
    const validatorUri = this.uri(validatorKey);
    const solutionRows: {
      name: string;
      language: string;
      expectedVerdict: Verdict;
      sourceUri: string;
    }[] = [];
    for (const s of pkg.solutions) {
      const key = `solutions/${sha256(s.source)}`;
      await this.put(key, s.source, 'text/plain');
      solutionRows.push({
        name: s.name,
        language: s.language,
        expectedVerdict: s.expected,
        sourceUri: this.uri(key),
      });
    }

    return this.db.transaction(async (tx) => {
      await tx
        .insert(problems)
        .values({
          slug: pkg.slug,
          title: pkg.title,
          difficulty: pkg.rating,
          practicePoints: pkg.practicePoints,
          authorId: opts.actorId ?? null,
        })
        .onConflictDoNothing({ target: problems.slug });
      // jsonb does not keep key order, so the stored fields are compared structurally.
      // Serialises concurrent imports of the same slug, so version numbers never collide.
      const [problem] = await tx
        .select()
        .from(problems)
        .where(eq(problems.slug, pkg.slug))
        .for('update');
      const [last] = await tx
        .select()
        .from(problemVersions)
        .where(eq(problemVersions.problemId, problem!.id))
        .orderBy(sql`${problemVersions.version} desc`)
        .limit(1);

      const same =
        last !== undefined &&
        last.testsetHash === hash &&
        last.statementMd === pkg.statementMd &&
        last.editorialMd === pkg.editorialMd &&
        isDeepStrictEqual(last.limits, pkg.limits) &&
        isDeepStrictEqual(last.checker, checker) &&
        isDeepStrictEqual(last.samples, pkg.samples) &&
        (last.validatorUri === null || last.validatorUri === validatorUri) &&
        problem!.difficulty === pkg.rating &&
        JSON.stringify(await this.solutionsOf(tx, last.id)) ===
          JSON.stringify(sortedSolutions(solutionRows)) &&
        JSON.stringify([...(await this.tagsOf(tx, problem!.id))]) ===
          JSON.stringify([...pkg.tags].sort());

      if (same) {
        // Versions imported before validators were stored get theirs now; nothing else changes.
        if (last.validatorUri === null) {
          await tx
            .update(problemVersions)
            .set({ validatorUri })
            .where(eq(problemVersions.id, last.id));
        }
        if (opts.visibility && opts.visibility !== problem!.visibility) {
          await tx
            .update(problems)
            .set({ visibility: opts.visibility })
            .where(eq(problems.id, problem!.id));
        }
        return {
          outcome: 'unchanged' as const,
          problemId: problem!.id,
          versionId: last.id,
          version: last.version,
          testsetHash: hash,
          testsCount: last.testsCount,
        };
      }

      const version = (last?.version ?? 0) + 1;
      const [row] = await tx
        .insert(problemVersions)
        .values({
          problemId: problem!.id,
          version,
          statementMd: pkg.statementMd,
          editorialMd: pkg.editorialMd,
          limits: pkg.limits,
          checker,
          testsetHash: hash,
          testsetUri: this.uri(testsetKey),
          validatorUri,
          testsCount: pkg.tests.length,
          samples: pkg.samples,
          createdBy: opts.actorId ?? null,
        })
        .returning({ id: problemVersions.id });
      await tx
        .insert(packageSolutions)
        .values(solutionRows.map((s) => ({ ...s, versionId: row!.id })));

      await tx.delete(problemTags).where(eq(problemTags.problemId, problem!.id));
      await tx.insert(problemTags).values(pkg.tags.map((tag) => ({ problemId: problem!.id, tag })));
      await tx
        .update(problems)
        .set({
          title: pkg.title,
          difficulty: pkg.rating,
          practicePoints: pkg.practicePoints,
          currentVersionId: row!.id,
          ...(opts.visibility ? { visibility: opts.visibility } : {}),
        })
        .where(eq(problems.id, problem!.id));
      return {
        outcome: last ? ('new-version' as const) : ('created' as const),
        problemId: problem!.id,
        versionId: row!.id,
        version,
        testsetHash: hash,
        testsCount: pkg.tests.length,
      };
    });
  }

  private async solutionsOf(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    versionId: string,
  ) {
    const rows = await tx
      .select({
        name: packageSolutions.name,
        language: packageSolutions.language,
        expectedVerdict: packageSolutions.expectedVerdict,
        sourceUri: packageSolutions.sourceUri,
      })
      .from(packageSolutions)
      .where(eq(packageSolutions.versionId, versionId));
    return sortedSolutions(rows);
  }

  private async tagsOf(tx: Parameters<Parameters<Db['transaction']>[0]>[0], problemId: string) {
    const rows = await tx
      .select({ tag: problemTags.tag })
      .from(problemTags)
      .where(eq(problemTags.problemId, problemId));
    return rows.map((r) => r.tag).sort();
  }
}
