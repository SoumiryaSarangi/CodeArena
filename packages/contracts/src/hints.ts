import { z } from 'zod';

/** 1 Concept → 2 Approach → 3 Next step (PRD §9.5). */
export const HintLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type HintLevel = z.infer<typeof HintLevel>;

/** Practice points lost for the highest level used (cumulative maximum, not additive; FR-AI-04). */
export const HINT_PENALTY_PERCENT: Record<HintLevel, number> = { 1: 10, 2: 25, 3: 50 };

/** POST /api/hints */
export const CreateHint = z
  .object({
    problemSlug: z.string().min(1).max(100),
    level: HintLevel,
    /** The attempt to ground the hint in (mine, for this problem); default: my latest. */
    submissionId: z.uuid().optional(),
  })
  .strict()
  .meta({ id: 'CreateHint' });
export type CreateHint = z.infer<typeof CreateHint>;

/** What an unlocked level shows. */
export const HintItem = z
  .object({
    level: HintLevel,
    status: z.enum(['locked', 'available', 'delivered']),
    /** Percent of the problem's practice points this level costs (shown before unlocking). */
    costPercent: z.number().int(),
    hintId: z.uuid().nullable(),
    text: z.string().nullable(),
    helpful: z.boolean().nullable(),
  })
  .strict()
  .meta({ id: 'HintItem' });
export type HintItem = z.infer<typeof HintItem>;

/** GET /api/hints?problemSlug= */
export const HintState = z
  .object({
    /** False in a running contest that includes the problem, or when AI is switched off. */
    enabled: z.boolean(),
    disabledReason: z.string().nullable(),
    levels: z.array(HintItem).length(3),
    practicePoints: z.number().int().nullable(),
    /** Practice points after the penalty of the highest real hint delivered. */
    effectivePoints: z.number().int().nullable(),
    penaltyPercent: z.number().int(),
    remainingThisHour: z.number().int(),
  })
  .strict()
  .meta({ id: 'HintState' });
export type HintState = z.infer<typeof HintState>;

/** POST /api/hints: a hint, or a nudge when there is not enough to go on (nothing charged). */
export const HintResult = z
  .object({
    hint: z
      .object({
        id: z.uuid(),
        level: HintLevel,
        text: z.string(),
        /** Percent of practice points lost in total after this one (0 for a generic fallback). */
        penaltyPercent: z.number().int(),
        /** Served from the cache or from an earlier request: no model was called. */
        cached: z.boolean(),
        /** The safe generic text, because every try at a real hint failed the filter. */
        generic: z.boolean(),
      })
      .strict()
      .nullable(),
    nudge: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'HintResult' });
export type HintResult = z.infer<typeof HintResult>;

/** POST /api/hints/{id}/rating */
export const RateHint = z.object({ helpful: z.boolean() }).strict().meta({ id: 'RateHint' });
export type RateHint = z.infer<typeof RateHint>;
