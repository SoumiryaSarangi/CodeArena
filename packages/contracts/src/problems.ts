import { z } from 'zod';
import { page } from './http';

const tag = z.string().min(1).max(30);

/** A row of the practice list (SRS §3.1.2: GET /api/problems). */
export const ProblemSummary = z
  .object({
    slug: z.string(),
    title: z.string(),
    /** Rating, 800–3500 in steps of 100. */
    difficulty: z.number().int(),
    tags: z.array(tag),
    practicePoints: z.number().int().nullable(),
    /** Share of all submissions that were accepted, 0-100 (one decimal); null until anyone has submitted. */
    acceptance: z.number().min(0).max(100).nullable(),
    /** The signed-in user's state on this problem; null for guests. */
    status: z.enum(['solved', 'attempted', 'new']).nullable(),
  })
  .strict()
  .meta({ id: 'ProblemSummary' });
export type ProblemSummary = z.infer<typeof ProblemSummary>;

export const ProblemList = page(ProblemSummary).meta({ id: 'ProblemList' });
export type ProblemList = z.infer<typeof ProblemList>;

/** `?q&tags&minDiff&maxDiff&cursor&limit`: filters combine with AND (FR-PROB-08). */
export const ProblemListQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    /** Comma-separated; a problem must carry every tag. */
    tags: z
      .string()
      .transform((v) =>
        v
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      )
      .pipe(z.array(tag).max(10))
      .optional(),
    /** Needs a signed-in user: guests get 401. */
    status: z.enum(['solved', 'attempted', 'new']).optional(),
    minDiff: z.coerce.number().int().min(800).max(3500).optional(),
    maxDiff: z.coerce.number().int().min(800).max(3500).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ProblemListQuery = z.infer<typeof ProblemListQuery>;

/** What a visitor may see of a problem: never hidden tests, the editorial or the solutions (FR-PROB-06). */
export const ProblemDetail = ProblemSummary.omit({ acceptance: true, status: true })
  .extend({
    version: z.number().int().min(1),
    /** How many tests the judge runs (the verdict grid's size); their contents are never shown. */
    testsCount: z.number().int().min(1),
    /** Markdown with KaTeX; the web renders it sanitised (FR-PROB-07). */
    statementMd: z.string(),
    samples: z.array(z.object({ in: z.string(), out: z.string() }).strict()),
    limits: z.object({ timeMs: z.number(), memMb: z.number(), outputKb: z.number() }).strict(),
    /** Describes how output is compared; a testlib checker's source is not shown. */
    checker: z
      .object({ kind: z.enum(['exact', 'tokens', 'float', 'testlib']), eps: z.number().optional() })
      .strict(),
  })
  .strict()
  .meta({ id: 'ProblemDetail' });
export type ProblemDetail = z.infer<typeof ProblemDetail>;

/** The tags in use on public problems, for the filter (GET /api/problems/tags). */
export const ProblemTags = z
  .object({ items: z.array(z.object({ tag: tag, count: z.number().int().min(1) }).strict()) })
  .strict()
  .meta({ id: 'ProblemTags' });
export type ProblemTags = z.infer<typeof ProblemTags>;
