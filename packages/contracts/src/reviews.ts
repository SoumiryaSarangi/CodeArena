import { z } from 'zod';
import { Verdict } from './enums';

/** Post-contest AI reviews (AI-03): SRS FR-AI-08, PRD US-8.2. */

export const ReviewStatus = z.enum(['queued', 'generating', 'ready', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/** One reviewed problem: my final submission and its review. */
export const ReviewItem = z
  .object({
    reviewId: z.uuid(),
    submissionId: z.uuid(),
    label: z.string(),
    problemSlug: z.string(),
    problemTitle: z.string(),
    verdict: Verdict.nullable(),
    failedTest: z.number().int().nullable(),
    status: ReviewStatus,
    /** Markdown with four sections; present when ready. */
    contentMd: z.string().nullable(),
    helpful: z.boolean().nullable(),
  })
  .strict()
  .meta({ id: 'ReviewItem' });
export type ReviewItem = z.infer<typeof ReviewItem>;

/** `GET /api/reviews?contest={slug}`: my reviews, one per attempted problem (final contests only). */
export const ReviewList = z
  .object({ items: z.array(ReviewItem) })
  .strict()
  .meta({ id: 'ReviewList' });
export type ReviewList = z.infer<typeof ReviewList>;

/** `GET /api/reviews/by-submission/{id}`: opening a review generates it if it is not there yet. */
export const ReviewResult = z
  .object({
    status: ReviewStatus,
    reviewId: z.uuid(),
    contentMd: z.string().nullable(),
    helpful: z.boolean().nullable(),
  })
  .strict()
  .meta({ id: 'ReviewResult' });
export type ReviewResult = z.infer<typeof ReviewResult>;
