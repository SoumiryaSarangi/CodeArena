import { z } from 'zod';
import { Lane } from './enums';

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
