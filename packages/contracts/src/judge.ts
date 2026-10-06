import { z } from 'zod';
import { CheckerKind, JobMode, JudgePhase, Lane, Language, Verdict } from './enums';

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
const byteLen = (s: string) => new TextEncoder().encode(s).length;

const epochMs = z.number().int().nonnegative();

export const Limits = z
  .object({
    timeMs: z.number().int().positive(),
    memMb: z.number().int().positive(),
    outputKb: z.number().int().positive(),
  })
  .strict()
  .meta({ id: 'Limits' });

export const Checker = z
  .object({
    kind: CheckerKind,
    eps: z.number().positive().optional(),
    /** Object holding the checker's C++ source (compiled on each judge, SD-§8.5). */
    sourceUri: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.kind === 'float' && c.eps === undefined) {
      ctx.addIssue({ code: 'custom', path: ['eps'], message: 'float checker requires eps' });
    }
    if (c.kind === 'testlib' && c.sourceUri === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceUri'],
        message: 'testlib checker requires sourceUri',
      });
    }
  })
  .meta({ id: 'Checker' });

export const ProblemRef = z
  .object({
    versionId: z.string().min(1),
    testsetHash: z.string().min(1),
    testsetUri: z.string().min(1),
    checker: Checker,
    limits: Limits,
  })
  .strict()
  .meta({ id: 'ProblemRef' });

/** When `mode` is `run`, `submissionId` carries the `custom_runs.id`. */
export const JudgeJob = z
  .object({
    jobId: z.string().min(1),
    submissionId: z.string().min(1),
    runVersion: z.number().int().min(1),
    lane: Lane,
    language: Language,
    source: z.string().refine((s) => byteLen(s) <= MAX_SOURCE_BYTES, 'source exceeds 64 KB'),
    problem: ProblemRef,
    mode: JobMode,
    customInput: z
      .string()
      .refine((s) => byteLen(s) <= MAX_INPUT_BYTES, 'input exceeds 1 MB')
      .optional(),
    stopOnFirstFailure: z.boolean(),
    traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    enqueuedAt: epochMs,
    seq: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'JudgeJob' });
export type JudgeJob = z.infer<typeof JudgeJob>;

export const TestOutcome = z
  .object({
    no: z.number().int().min(1),
    verdict: Verdict,
    timeMs: z.number().int().nonnegative(),
    memKb: z.number().int().nonnegative(),
    checkerMsg: z.string().max(256).optional(),
    signal: z.string().optional(),
  })
  .strict()
  .meta({ id: 'TestOutcome' });
export type TestOutcome = z.infer<typeof TestOutcome>;

export const JudgeProgress = z
  .object({
    submissionId: z.string().min(1),
    runVersion: z.number().int().min(1),
    phase: JudgePhase,
    workerId: z.string().min(1),
    test: TestOutcome.optional(),
    ts: epochMs,
  })
  .strict()
  .meta({ id: 'JudgeProgress' });
export type JudgeProgress = z.infer<typeof JudgeProgress>;

export const JudgeResult = z
  .object({
    submissionId: z.string().min(1),
    runVersion: z.number().int().min(1),
    verdict: Verdict,
    timeMs: z.number().int().nonnegative(),
    memKb: z.number().int().nonnegative(),
    compileLog: z
      .string()
      .refine((s) => byteLen(s) <= MAX_LOG_BYTES, 'compile log exceeds 64 KB')
      .optional(),
    tests: z.array(TestOutcome),
    /**
     * Only for custom runs (`mode: run` with `customInput`): the program's stdout and stderr,
     * each cut at 64 KB. Never set for problem tests, whose outputs must not leak.
     */
    output: z
      .string()
      .refine((s) => byteLen(s) <= MAX_LOG_BYTES, 'output exceeds 64 KB')
      .optional(),
    stderr: z
      .string()
      .refine((s) => byteLen(s) <= MAX_LOG_BYTES, 'stderr exceeds 64 KB')
      .optional(),
    workerId: z.string().min(1),
    finishedAt: epochMs,
  })
  .strict()
  .meta({ id: 'JudgeResult' });
export type JudgeResult = z.infer<typeof JudgeResult>;
