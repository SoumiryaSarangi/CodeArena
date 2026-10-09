import { z } from 'zod';

/** Advisory editor signals (IN-01, SRS FR-SIG-01, SD-§14). Never used to change a score. */

export const SignalKind = z.enum(['paste', 'blur', 'focus', 'tab_hidden', 'problem_open']);
export type SignalKind = z.infer<typeof SignalKind>;

/** A paste is only reported above this many characters (SRS FR-SIG-01). */
export const PASTE_MIN_CHARS = 50;
export const SIGNAL_BATCH_MAX = 50;

/** POST /api/signals: a batch from the contest page. 204, nothing is returned. */
export const SignalBatch = z
  .object({
    contest: z.string().min(1).max(80),
    problem: z.string().min(1).max(8),
    events: z
      .array(
        z
          .object({
            kind: SignalKind,
            /** Characters pasted (paste only). */
            size: z.number().int().min(1).max(10_000_000).optional(),
            at: z.iso.datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(SIGNAL_BATCH_MAX),
  })
  .strict()
  .meta({ id: 'SignalBatch' });
export type SignalBatch = z.infer<typeof SignalBatch>;
