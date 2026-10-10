import { z } from 'zod';
import { Lane, Verdict } from './enums';

/** The public status page (O-02, SRS GET /api/status, UI_UX S18). */

export const ComponentState = z.enum(['ok', 'degraded', 'down', 'planned']);
export type ComponentState = z.infer<typeof ComponentState>;

export const PlatformStatus = z
  .object({
    serverNow: z.string(),
    /** The worst state of the parts that matter for judging. */
    overall: z.enum(['ok', 'degraded', 'down']),
    components: z.array(
      z
        .object({
          id: z.enum(['api', 'database', 'queue', 'judges', 'realtime', 'pad']),
          label: z.string(),
          state: ComponentState,
          /** One plain sentence, e.g. "2 judges reporting". */
          detail: z.string(),
        })
        .strict(),
    ),
    queue: z.array(z.object({ lane: Lane, depth: z.number().int().min(0) }).strict()),
    /** Submit to verdict over the last 15 minutes (null: nothing judged then). */
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    totals: z
      .object({
        submissionsJudged: z.number().int().min(0),
        contestsHosted: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'PlatformStatus' });
export type PlatformStatus = z.infer<typeof PlatformStatus>;

/**
 * GET /api/status/verdicts: the landing page's live strip (UI-16). The last few finished PRACTICE
 * verdicts on PUBLIC problems and nothing else: no handle, no ids, no code. Contest and private
 * activity never appears, so it cannot reveal what is being solved during a contest or a freeze.
 */
export const PublicVerdicts = z
  .object({
    items: z
      .array(
        z
          .object({
            language: z.string(),
            problemTitle: z.string(),
            verdict: Verdict,
            timeMs: z.number().int().nullable(),
            /** When it was judged. */
            at: z.string(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .meta({ id: 'PublicVerdicts' });
export type PublicVerdicts = z.infer<typeof PublicVerdicts>;
