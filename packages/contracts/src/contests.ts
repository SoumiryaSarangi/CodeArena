import { z } from 'zod';
import { Language } from './enums';

/** Contests (C-01): SRS §3.2.7 (FR-CONT-01..03), PRD §9.1–9.3. */

const iso = z.string();
export const ContestSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,59}$/, 'a-z, 0-9 and -, 3–60 chars');

/** What the server derives from its own clock (FR-CONT-03); `draft` and `finalized` are stored. */
export const ContestState = z
  .enum(['draft', 'scheduled', 'running', 'ended', 'finalized'])
  .meta({ id: 'ContestState' });
export type ContestState = z.infer<typeof ContestState>;

export const ContestRules = z
  .object({
    penaltyMinutes: z.number().int().min(0).max(120).default(20),
    ceCountsAsAttempt: z.boolean().default(false),
    /** Time-limit multiplier per language (PRD §9.3). */
    langMultipliers: z
      .partialRecord(Language, z.number().min(1).max(10))
      .default({ c: 1, cpp17: 1, cpp20: 1, java21: 2, node: 2, python3: 3 }),
    rated: z.boolean().default(true),
    lateRegistration: z.boolean().default(true),
  })
  .strict()
  .meta({ id: 'ContestRules' });
export type ContestRules = z.infer<typeof ContestRules>;

const times = z.object({
  startsAt: iso.datetime({ offset: true }),
  endsAt: iso.datetime({ offset: true }),
  /** Null or absent: no freeze. */
  freezeAt: iso.datetime({ offset: true }).nullish(),
});

const timesOk = (v: { startsAt?: string; endsAt?: string; freezeAt?: string | null }) => {
  const s = v.startsAt ? Date.parse(v.startsAt) : undefined;
  const e = v.endsAt ? Date.parse(v.endsAt) : undefined;
  const f = v.freezeAt ? Date.parse(v.freezeAt) : undefined;
  if (s !== undefined && e !== undefined && e <= s) return false;
  if (f !== undefined && s !== undefined && f < s) return false;
  if (f !== undefined && e !== undefined && f >= e) return false;
  return true;
};
const TIMES_MSG = 'Need start < end, and the freeze between start and end';

export const ContestCreate = times
  .extend({
    slug: ContestSlug,
    title: z.string().trim().min(3).max(120),
    description: z.string().max(5000).default(''),
    rules: ContestRules.default(ContestRules.parse({})),
  })
  .strict()
  .refine(timesOk, { message: TIMES_MSG, path: ['endsAt'] })
  .meta({ id: 'ContestCreate' });
export type ContestCreate = z.infer<typeof ContestCreate>;

export const ContestPatch = times
  .partial()
  .extend({
    title: z.string().trim().min(3).max(120).optional(),
    description: z.string().max(5000).optional(),
    rules: ContestRules.partial().optional(),
    /** true: make it visible (needs problems with validated versions); false: back to draft. */
    published: z.boolean().optional(),
  })
  .strict()
  .refine(timesOk, { message: TIMES_MSG, path: ['endsAt'] })
  .meta({ id: 'ContestPatch' });
export type ContestPatch = z.infer<typeof ContestPatch>;

export const ContestProblemsPut = z
  .object({
    items: z
      .array(
        z.object({ label: z.string().regex(/^[A-Z]$/), slug: z.string().min(1).max(100) }).strict(),
      )
      .max(26),
  })
  .strict()
  .refine((v) => new Set(v.items.map((i) => i.label)).size === v.items.length, {
    message: 'Labels must be unique',
    path: ['items'],
  })
  .refine((v) => new Set(v.items.map((i) => i.slug)).size === v.items.length, {
    message: 'A problem can appear once',
    path: ['items'],
  })
  .meta({ id: 'ContestProblemsPut' });
export type ContestProblemsPut = z.infer<typeof ContestProblemsPut>;

export const ContestSummary = z
  .object({
    slug: z.string(),
    title: z.string(),
    state: ContestState,
    startsAt: iso,
    endsAt: iso,
    freezeAt: iso.nullable(),
    problemCount: z.number().int(),
    registeredCount: z.number().int(),
    /** Only for a signed-in user. */
    registered: z.boolean(),
  })
  .strict()
  .meta({ id: 'ContestSummary' });
export type ContestSummary = z.infer<typeof ContestSummary>;

export const ContestList = z
  .object({ serverNow: iso, items: z.array(ContestSummary) })
  .strict()
  .meta({ id: 'ContestList' });
export type ContestList = z.infer<typeof ContestList>;

export const ContestDetail = ContestSummary.extend({
  description: z.string(),
  rules: ContestRules,
  /** Clients compute countdowns from this, not from their own clock (FR-CONT-03). */
  serverNow: iso,
  /** Can this viewer register right now? Reason when not. */
  canRegister: z.boolean(),
})
  .strict()
  .meta({ id: 'ContestDetail' });
export type ContestDetail = z.infer<typeof ContestDetail>;

export const ContestProblemItem = z
  .object({
    label: z.string(),
    title: z.string(),
    slug: z.string(),
    difficulty: z.number().int(),
    limits: z.object({ timeMs: z.number(), memMb: z.number(), outputKb: z.number() }).strict(),
  })
  .strict()
  .meta({ id: 'ContestProblemItem' });
export type ContestProblemItem = z.infer<typeof ContestProblemItem>;

export const ContestProblemList = z
  .object({ serverNow: iso, items: z.array(ContestProblemItem) })
  .strict()
  .meta({ id: 'ContestProblemList' });
export type ContestProblemList = z.infer<typeof ContestProblemList>;

export const ContestProblemDetail = ContestProblemItem.extend({
  statementMd: z.string(),
  samples: z.array(z.object({ in: z.string(), out: z.string() }).strict()),
  testsCount: z.number().int(),
})
  .strict()
  .meta({ id: 'ContestProblemDetail' });
export type ContestProblemDetail = z.infer<typeof ContestProblemDetail>;

export const AdminContestProblem = z
  .object({
    label: z.string(),
    slug: z.string(),
    title: z.string(),
    version: z.number().int(),
    validationStatus: z.enum(['pending', 'running', 'passed', 'failed']).nullable(),
  })
  .strict();

export const AdminContestDetail = ContestDetail.extend({
  id: z.string(),
  problems: z.array(AdminContestProblem),
})
  .strict()
  .meta({ id: 'AdminContestDetail' });
export type AdminContestDetail = z.infer<typeof AdminContestDetail>;

export const AdminContestList = z
  .object({ serverNow: iso, items: z.array(ContestSummary.extend({ id: z.string() })) })
  .strict()
  .meta({ id: 'AdminContestList' });
export type AdminContestList = z.infer<typeof AdminContestList>;
