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
    /** ≤ 40 keeps the packed board score exact (SD-§9.2: 26 · (1023 + 40 · 99) < 2^17). */
    penaltyMinutes: z.number().int().min(0).max(40).default(20),
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

/** The packed board score holds the last-AC minute in 10 bits (SD-§9.2). */
export const MAX_CONTEST_MINUTES = 1023;
const MAX_CONTEST_MS = MAX_CONTEST_MINUTES * 60_000;

const timesOk = (v: { startsAt?: string; endsAt?: string; freezeAt?: string | null }) => {
  const s = v.startsAt ? Date.parse(v.startsAt) : undefined;
  const e = v.endsAt ? Date.parse(v.endsAt) : undefined;
  const f = v.freezeAt ? Date.parse(v.freezeAt) : undefined;
  if (s !== undefined && e !== undefined && e <= s) return false;
  if (s !== undefined && e !== undefined && e - s > MAX_CONTEST_MS) return false;
  if (f !== undefined && s !== undefined && f < s) return false;
  if (f !== undefined && e !== undefined && f >= e) return false;
  return true;
};
const TIMES_MSG =
  'Need start < end, at most 1023 minutes long, and the freeze between start and end';

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
  /** For realtime topics (`contest:{id}:clar`). */
  id: z.string(),
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
  checker: z
    .object({ kind: z.enum(['exact', 'tokens', 'float', 'testlib']), eps: z.number().optional() })
    .strict(),
})
  .strict()
  .meta({ id: 'ContestProblemDetail' });
export type ContestProblemDetail = z.infer<typeof ContestProblemDetail>;

export const AdminContestProblem = z
  .object({
    label: z.string(),
    problemId: z.string(),
    slug: z.string(),
    title: z.string(),
    version: z.number().int(),
    validationStatus: z.enum(['pending', 'running', 'passed', 'failed']).nullable(),
    /** Hidden from contestants and the board (C-07). */
    hidden: z.boolean(),
  })
  .strict();

export const AdminContestDetail = ContestDetail.extend({
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

/** One cell of the board (FR-BOARD-07). Cells a user never touched are absent. */
export const BoardCell = z
  .object({
    /** Rejected attempts before the first AC (all of them if unsolved); CE only when the rules say so. */
    attempts: z.number().int().min(0),
    /** Contest minute of the first AC, or null. */
    acMinute: z.number().int().min(0).nullable(),
    /** Submissions not judged yet; in the frozen view also every attempt after the freeze. */
    pending: z.number().int().min(0),
    /** The first AC on this problem in the contest. */
    first: z.boolean(),
  })
  .strict()
  .meta({ id: 'BoardCell' });
export type BoardCell = z.infer<typeof BoardCell>;

export const BoardRow = z
  .object({
    rank: z.number().int().min(1),
    userId: z.string(),
    handle: z.string(),
    solved: z.number().int().min(0),
    penalty: z.number().int().min(0),
    lastAcMinute: z.number().int().min(0).nullable(),
    /** The packed composite score (SD-§9.2); higher is better, equal scores share a rank. */
    score: z.number().int(),
    cells: z.record(z.string(), BoardCell),
  })
  .strict()
  .meta({ id: 'BoardRow' });
export type BoardRow = z.infer<typeof BoardRow>;

export const BoardSnapshot = z
  .object({
    /** For the realtime topics `contest:{id}:board` / `admin:contest:{id}:board`. */
    contestId: z.string(),
    serverNow: iso,
    /** Diffs with a lower or equal version are already included. */
    version: z.number().int().min(0),
    /** True when this view hides other people's results after the freeze. */
    frozen: z.boolean(),
    problems: z.array(
      z
        .object({
          label: z.string(),
          solvedCount: z.number().int().min(0),
          firstSolverId: z.string().nullable(),
        })
        .strict(),
    ),
    rows: z.array(BoardRow),
  })
  .strict()
  .meta({ id: 'BoardSnapshot' });
export type BoardSnapshot = z.infer<typeof BoardSnapshot>;

/**
 * `board.diff` on `contest:{id}:board` (public view) and `admin:contest:{id}:board` (live view):
 * the rows that changed. Ranks of other rows may shift too, so clients re-rank by `score`.
 */
export const BoardDiffData = z
  .object({
    contestId: z.string(),
    version: z.number().int().min(0),
    frozen: z.boolean(),
    rows: z.array(BoardRow.omit({ rank: true })),
  })
  .strict()
  .meta({ id: 'BoardDiffData' });
export type BoardDiffData = z.infer<typeof BoardDiffData>;

/** Clarifications and announcements (C-05, FR-CONT-04). */
export const ClarificationCreate = z
  .object({
    /** A problem label, or absent for a general question. */
    problemLabel: z
      .string()
      .regex(/^[A-Z]$/)
      .nullish(),
    question: z.string().trim().min(1).max(2000),
  })
  .strict()
  .meta({ id: 'ClarificationCreate' });
export type ClarificationCreate = z.infer<typeof ClarificationCreate>;

export const ClarificationItem = z
  .object({
    id: z.string(),
    problemLabel: z.string().nullable(),
    question: z.string(),
    answer: z.string().nullable(),
    /** An answer for everyone (the question is then shown to everyone too). */
    isPublic: z.boolean(),
    /** I asked it. */
    mine: z.boolean(),
    createdAt: iso,
    answeredAt: iso.nullable(),
  })
  .strict()
  .meta({ id: 'ClarificationItem' });
export type ClarificationItem = z.infer<typeof ClarificationItem>;

export const ClarificationList = z
  .object({ items: z.array(ClarificationItem) })
  .strict()
  .meta({ id: 'ClarificationList' });
export type ClarificationList = z.infer<typeof ClarificationList>;

export const AdminClarificationItem = ClarificationItem.extend({
  askerId: z.string(),
  askerHandle: z.string(),
})
  .strict()
  .meta({ id: 'AdminClarificationItem' });
export type AdminClarificationItem = z.infer<typeof AdminClarificationItem>;

export const AdminClarificationList = z
  .object({ items: z.array(AdminClarificationItem) })
  .strict()
  .meta({ id: 'AdminClarificationList' });
export type AdminClarificationList = z.infer<typeof AdminClarificationList>;

export const ClarificationAnswer = z
  .object({ answer: z.string().trim().min(1).max(2000), isPublic: z.boolean() })
  .strict()
  .meta({ id: 'ClarificationAnswer' });
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;

export const AnnouncementCreate = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .strict()
  .meta({ id: 'AnnouncementCreate' });
export type AnnouncementCreate = z.infer<typeof AnnouncementCreate>;

export const Announcement = z
  .object({ id: z.string(), body: z.string(), createdAt: iso })
  .strict()
  .meta({ id: 'Announcement' });
export type Announcement = z.infer<typeof Announcement>;

/**
 * The reply to POST /admin/contests/{id}/announcements: the announcement plus how far it got, so the
 * organiser can tell "nobody is connected" from "sent" (C-09). `reached` counts the live streams
 * open on this API instance at that moment; contestants who open the page later still see it.
 */
export const AnnouncementSent = z
  .object({
    id: z.string(),
    body: z.string(),
    createdAt: iso,
    reached: z.number().int().min(0),
    registered: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'AnnouncementSent' });
export type AnnouncementSent = z.infer<typeof AnnouncementSent>;

export const AnnouncementList = z
  .object({ items: z.array(Announcement) })
  .strict()
  .meta({ id: 'AnnouncementList' });
export type AnnouncementList = z.infer<typeof AnnouncementList>;

/**
 * Events (SD-§10). `clar.new` goes to `admin:contest:{id}:clar` with the asker. `clar.answer` goes to
 * `contest:{id}:clar` (public answers) or `contest:{id}:u:{userId}` (a private answer to its asker)
 * and never names the asker. `announce.new` goes to `contest:{id}:clar` with an `Announcement`.
 */
export const ClarificationNewEvent = z
  .object({ contestId: z.string(), item: AdminClarificationItem })
  .strict()
  .meta({ id: 'ClarificationNewEvent' });
export type ClarificationNewEvent = z.infer<typeof ClarificationNewEvent>;

export const ClarificationEvent = z
  .object({ contestId: z.string(), item: ClarificationItem })
  .strict()
  .meta({ id: 'ClarificationEvent' });
export type ClarificationEvent = z.infer<typeof ClarificationEvent>;

export const AnnouncementEvent = z
  .object({ contestId: z.string(), item: Announcement })
  .strict()
  .meta({ id: 'AnnouncementEvent' });
export type AnnouncementEvent = z.infer<typeof AnnouncementEvent>;
