import { z } from 'zod';

/** Finalising contests and ratings (C-08): SRS FR-CONT-07, FR-RATE-01..03. */

export const RatingChangeRow = z
  .object({
    userId: z.string(),
    handle: z.string(),
    /** Rank among the rated participants (ties share a rank). */
    rank: z.number().int().min(1),
    oldRating: z.number().int(),
    newRating: z.number().int(),
    delta: z.number().int(),
  })
  .strict()
  .meta({ id: 'RatingChangeRow' });
export type RatingChangeRow = z.infer<typeof RatingChangeRow>;

/** `GET /contests/{slug}/results`: final once the contest is finalised. */
export const ContestResults = z
  .object({
    serverNow: z.string(),
    /** False when the contest is unrated or had fewer than 5 participants. */
    rated: z.boolean(),
    changes: z.array(RatingChangeRow),
  })
  .strict()
  .meta({ id: 'ContestResults' });
export type ContestResults = z.infer<typeof ContestResults>;

export const FinalizeResult = z
  .object({ rated: z.boolean(), changes: z.number().int().min(0) })
  .strict()
  .meta({ id: 'FinalizeResult' });
export type FinalizeResult = z.infer<typeof FinalizeResult>;

export const RecomputeResult = z
  .object({
    /** Rating rows whose numbers differ from before (0 when the recompute agrees). */
    differing: z.number().int().min(0),
    changes: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'RecomputeResult' });
export type RecomputeResult = z.infer<typeof RecomputeResult>;

/** `GET /users/{handle}/ratings`: the rating graph and contest history of a profile. */
export const RatingHistory = z
  .object({
    handle: z.string(),
    rating: z.number().int(),
    history: z.array(
      z
        .object({
          contestSlug: z.string(),
          contestTitle: z.string(),
          endedAt: z.string(),
          rank: z.number().int().min(1),
          oldRating: z.number().int(),
          newRating: z.number().int(),
          delta: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'RatingHistory' });
export type RatingHistory = z.infer<typeof RatingHistory>;
