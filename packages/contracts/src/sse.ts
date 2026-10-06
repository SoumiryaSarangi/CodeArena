import { z } from 'zod';
import { Lane, Verdict } from './enums';

/** Event types: SD-§10. */
export const SseEventType = z
  .enum([
    'submission.progress',
    'submission.queue',
    'submission.verdict',
    'board.snapshot',
    'board.diff',
    'board.freeze',
    'board.resolve.step',
    'clar.new',
    'clar.answer',
    'announce.new',
    'contest.state',
    'review.ready',
    'sys.status',
  ])
  .meta({ id: 'SseEventType' });
export type SseEventType = z.infer<typeof SseEventType>;

export const sseEnvelope = <T extends z.ZodType>(data: T) =>
  z
    .object({
      topic: z.string().min(1),
      type: SseEventType,
      ts: z.number().int().nonnegative(),
      data,
    })
    .strict();

/** Payload of a `submission.verdict` event on topic `sub:{id}` (SD-§10). Hidden test contents never appear. */
export const SubmissionVerdictData = z
  .object({
    /** A submission id, or a custom run id for `POST /api/runs` jobs. */
    submissionId: z.string().min(1),
    runVersion: z.number().int().min(1),
    /** `failed` when the submission could not be judged (SE), `done` otherwise. */
    status: z.enum(['done', 'failed']),
    verdict: Verdict,
    timeMs: z.number().int().nonnegative(),
    memKb: z.number().int().nonnegative(),
    /** Number of the first test that did not pass, if any. */
    failedTest: z.number().int().min(1).nullable(),
  })
  .strict()
  .meta({ id: 'SubmissionVerdictData' });
export type SubmissionVerdictData = z.infer<typeof SubmissionVerdictData>;

/** Payload of a live `submission.queue` event on topic `sub:{id}`: where the job stands while it waits. Not replayed. */
export const SubmissionQueueData = z
  .object({
    submissionId: z.string().min(1),
    lane: Lane,
    /** Jobs ahead plus this one; 0 once a judge has taken it. Capped at 100. */
    position: z.number().int().min(0),
    etaSeconds: z.number().int().min(0),
    capped: z.boolean(),
  })
  .strict()
  .meta({ id: 'SubmissionQueueData' });
export type SubmissionQueueData = z.infer<typeof SubmissionQueueData>;
