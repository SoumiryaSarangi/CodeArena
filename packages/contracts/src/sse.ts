import { z } from 'zod';

/** Event types: SD-§10. */
export const SseEventType = z
  .enum([
    'submission.progress',
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
