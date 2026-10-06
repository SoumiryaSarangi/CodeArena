import { z } from 'zod';
import { page } from './http';
import { Lane, Verdict } from './enums';

/** POST /api/submissions (SRS §3.1.2). Contest submissions (`contestSlug` + `label`) arrive with C-01. */
export const CreateSubmission = z
  .object({
    problemSlug: z.string().min(1).max(100),
    /** Checked against the enabled languages: an unknown one is 422 `unsupported-language`. */
    language: z.string().min(1).max(20),
    /** ≤ 64 KB; over that is 413 `payload-too-large`. */
    source: z.string().min(1),
  })
  .strict()
  .meta({ id: 'CreateSubmission' });
export type CreateSubmission = z.infer<typeof CreateSubmission>;

export const SubmissionCreated = z
  .object({
    id: z.string(),
    lane: Lane,
    /** Jobs ahead plus this one; 0 when a judge already has it. Capped at 100. */
    position: z.number().int().min(0),
    etaSeconds: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'SubmissionCreated' });
export type SubmissionCreated = z.infer<typeof SubmissionCreated>;

/** POST /api/runs: either `input` or `sampleIds` (1-based sample numbers), never both. */
export const CreateRun = z
  .object({
    problemSlug: z.string().min(1).max(100),
    language: z.string().min(1).max(20),
    source: z.string().min(1),
    /** ≤ 1 MB; over that is 413. */
    input: z.string().optional(),
    sampleIds: z.array(z.number().int().min(1).max(20)).min(1).max(20).optional(),
  })
  .strict()
  .refine((r) => (r.input === undefined) !== (r.sampleIds === undefined), {
    message: 'give exactly one of input or sampleIds',
    path: ['input'],
  })
  .meta({ id: 'CreateRun' });
export type CreateRun = z.infer<typeof CreateRun>;

export const RunCreated = z
  .object({
    /** First run; with `sampleIds` there is one run per sample, in `runIds`. */
    runId: z.string(),
    runIds: z.array(z.string()),
  })
  .strict()
  .meta({ id: 'RunCreated' });
export type RunCreated = z.infer<typeof RunCreated>;

export const RunStatus = z.enum(['queued', 'running', 'done', 'failed']);

export const RunResult = z
  .object({
    id: z.string(),
    status: RunStatus,
    verdict: Verdict.nullable(),
    timeMs: z.number().int().nullable(),
    memKb: z.number().int().nullable(),
    output: z.string().nullable(),
    stderr: z.string().nullable(),
    compileLog: z.string().nullable(),
    /** For a sample run: the sample's expected output and whether the output matches it token by token. */
    expected: z.string().nullable(),
    matches: z.boolean().nullable(),
  })
  .strict()
  .meta({ id: 'RunResult' });
export type RunResult = z.infer<typeof RunResult>;

export const SubmissionSummary = z
  .object({
    id: z.string(),
    problemSlug: z.string(),
    problemTitle: z.string(),
    language: z.string(),
    status: z.enum(['queued', 'judging', 'done', 'failed']),
    verdict: Verdict.nullable(),
    timeMs: z.number().int().nullable(),
    memKb: z.number().int().nullable(),
    failedTest: z.number().int().nullable(),
    lane: Lane,
    createdAt: z.string(),
  })
  .strict()
  .meta({ id: 'SubmissionSummary' });
export type SubmissionSummary = z.infer<typeof SubmissionSummary>;

export const SubmissionList = page(SubmissionSummary).meta({ id: 'SubmissionList' });
export type SubmissionList = z.infer<typeof SubmissionList>;

/** `?problem&verdict&language&user&cursor&limit`; `user` (a user id) is for admins. */
export const SubmissionListQuery = z
  .object({
    problem: z.string().min(1).max(100).optional(),
    verdict: Verdict.optional(),
    language: z.string().min(1).max(20).optional(),
    user: z.uuid().optional(),
    cursor: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type SubmissionListQuery = z.infer<typeof SubmissionListQuery>;

export const SubmissionDetail = SubmissionSummary.extend({
  source: z.string(),
  problemVersion: z.number().int(),
  runVersion: z.number().int(),
  /** Per test of the current run: verdict, time, memory. Test contents are never included. */
  tests: z.array(
    z
      .object({
        no: z.number().int(),
        verdict: Verdict,
        timeMs: z.number().int().nullable(),
        memKb: z.number().int().nullable(),
        /** Only for sample tests; for the others a checker message could reveal hidden data. */
        checkerMsg: z.string().nullable(),
      })
      .strict(),
  ),
  /** The compile log, for CE (≤ 16 KB). */
  compileLog: z.string().nullable(),
  journey: z
    .object({
      submittedAt: z.string(),
      judgedAt: z.string().nullable(),
      workerId: z.string().nullable(),
      /** When each phase of the judging run began (from the worker's progress events); may be partial or empty. */
      steps: z.array(
        z
          .object({ phase: z.enum(['claimed', 'compiling', 'running', 'done']), at: z.string() })
          .strict(),
      ),
    })
    .strict(),
  /** Admins only: every judging run of this submission (a rejudge adds one). */
  runs: z
    .array(
      z
        .object({
          runVersion: z.number().int(),
          reason: z.enum(['initial', 'retry', 'rejudge']),
          workerId: z.string().nullable(),
          verdict: Verdict.nullable(),
          finishedAt: z.string().nullable(),
        })
        .strict(),
    )
    .optional(),
})
  .strict()
  .meta({ id: 'SubmissionDetail' });
export type SubmissionDetail = z.infer<typeof SubmissionDetail>;

export const QueuePosition = z
  .object({
    lane: Lane,
    position: z.number().int().min(0),
    etaSeconds: z.number().int().min(0),
    /** True when more than 100 jobs are ahead and `position` is the cap. */
    capped: z.boolean(),
  })
  .strict()
  .meta({ id: 'QueuePosition' });
export type QueuePosition = z.infer<typeof QueuePosition>;
