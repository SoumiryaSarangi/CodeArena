import { z } from 'zod';
import { Verdict } from './enums';

/** Setter/admin screens (S15, UI-04): SRS §3.2.2 "Setter and admin". */

const Visibility = z.enum(['private', 'contest', 'public']);
const ValidationStatus = z.enum(['pending', 'running', 'passed', 'failed']);
const iso = z.string();
const Limits = z.object({ timeMs: z.number(), memMb: z.number(), outputKb: z.number() }).strict();
const Checker = z
  .object({ kind: z.enum(['exact', 'tokens', 'float', 'testlib']), eps: z.number().optional() })
  .strict();

export const AdminProblemSummary = z
  .object({
    slug: z.string(),
    title: z.string(),
    difficulty: z.number().int(),
    visibility: Visibility,
    /** Current version number; null before any version exists. */
    version: z.number().int().nullable(),
    testsCount: z.number().int(),
    validationStatus: ValidationStatus.nullable(),
    updatedAt: iso.nullable(),
    /** The signed-in setter authored it (admins see every problem). */
    mine: z.boolean(),
  })
  .strict()
  .meta({ id: 'AdminProblemSummary' });
export type AdminProblemSummary = z.infer<typeof AdminProblemSummary>;

export const AdminProblemList = z
  .object({ items: z.array(AdminProblemSummary) })
  .strict()
  .meta({ id: 'AdminProblemList' });
export type AdminProblemList = z.infer<typeof AdminProblemList>;

export const AdminVersionSummary = z
  .object({
    id: z.string(),
    version: z.number().int().min(1),
    createdAt: iso,
    testsCount: z.number().int(),
    testsetHash: z.string().nullable(),
    validationStatus: ValidationStatus,
    validatedAt: iso.nullable(),
  })
  .strict()
  .meta({ id: 'AdminVersionSummary' });
export type AdminVersionSummary = z.infer<typeof AdminVersionSummary>;

export const AdminSolution = z
  .object({ name: z.string(), language: z.string(), expected: Verdict })
  .strict()
  .meta({ id: 'AdminSolution' });
export type AdminSolution = z.infer<typeof AdminSolution>;

export const AdminProblemDetail = z
  .object({
    slug: z.string(),
    title: z.string(),
    difficulty: z.number().int(),
    tags: z.array(z.string()),
    practicePoints: z.number().int().nullable(),
    visibility: Visibility,
    mine: z.boolean(),
    versions: z.array(AdminVersionSummary),
    /** The version the other fields describe; null before any version exists. */
    current: z
      .object({
        id: z.string(),
        version: z.number().int().min(1),
        statementMd: z.string(),
        editorialMd: z.string(),
        limits: Limits,
        checker: Checker,
        samples: z.number().int(),
        solutions: z.array(AdminSolution),
        /** False for versions imported before validators were stored: re-upload to validate them. */
        validatorStored: z.boolean(),
        /** The most recent validation run of this version, so a reload shows its result. */
        lastRun: z
          .object({
            id: z.string(),
            status: z.enum(['queued', 'running', 'done', 'failed']),
            ok: z.boolean().nullable(),
            createdAt: iso,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .meta({ id: 'AdminProblemDetail' });
export type AdminProblemDetail = z.infer<typeof AdminProblemDetail>;

export const UploadResult = z
  .object({
    outcome: z.enum(['created', 'new-version', 'unchanged']),
    slug: z.string(),
    versionId: z.string(),
    version: z.number().int().min(1),
    testsCount: z.number().int(),
  })
  .strict()
  .meta({ id: 'UploadResult' });
export type UploadResult = z.infer<typeof UploadResult>;

/** `PATCH /api/admin/problems/{slug}/statement`. */
export const StatementPatch = z
  .object({
    statementMd: z.string().min(1).max(200_000),
    editorialMd: z.string().max(200_000),
  })
  .strict()
  .meta({ id: 'StatementPatch' });
export type StatementPatch = z.infer<typeof StatementPatch>;

export const VisibilityPatch = z
  .object({ visibility: Visibility })
  .strict()
  .meta({ id: 'VisibilityPatch' });
export type VisibilityPatch = z.infer<typeof VisibilityPatch>;

export const TestsList = z
  .object({
    items: z.array(
      z
        .object({
          no: z.number().int().min(1),
          inBytes: z.number().int(),
          ansBytes: z.number().int(),
          sample: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'TestsList' });
export type TestsList = z.infer<typeof TestsList>;

export const ValidationItem = z
  .object({
    kind: z.enum(['solution', 'validator']),
    name: z.string(),
    language: z.string(),
    /** What the package says this solution must get; `AC` for the validator (every input accepted). */
    expected: Verdict,
    status: z.enum(['queued', 'running', 'done', 'failed']),
    actual: Verdict.nullable(),
    timeMs: z.number().int().nullable(),
    memKb: z.number().int().nullable(),
    /** The tests that did not pass (at most 20), with the checker's or validator's message. */
    failedTests: z.array(
      z.object({ no: z.number().int(), verdict: Verdict, message: z.string().optional() }).strict(),
    ),
    /** `actual == expected`; null until done. */
    ok: z.boolean().nullable(),
    message: z.string().optional(),
  })
  .strict()
  .meta({ id: 'ValidationItem' });
export type ValidationItem = z.infer<typeof ValidationItem>;

export const ValidationRun = z
  .object({
    id: z.string(),
    versionId: z.string(),
    status: z.enum(['queued', 'running', 'done', 'failed']),
    createdAt: iso,
    finishedAt: iso.nullable(),
    /** Every item matched its expectation; null while running. */
    ok: z.boolean().nullable(),
    items: z.array(ValidationItem),
  })
  .strict()
  .meta({ id: 'ValidationRun' });
export type ValidationRun = z.infer<typeof ValidationRun>;
