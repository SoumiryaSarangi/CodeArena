import { z } from 'zod';
import { Lane } from './enums';

/** Contest operations (C-07): SRS FR-CONT-05, FR-OPS-01..03; screen S16. */

export const ContestExtend = z
  .object({ minutes: z.number().int().min(1).max(180) })
  .strict()
  .meta({ id: 'ContestExtend' });
export type ContestExtend = z.infer<typeof ContestExtend>;

export const ContestExtendResult = z
  .object({ endsAt: z.string(), announcementId: z.string() })
  .strict()
  .meta({ id: 'ContestExtendResult' });
export type ContestExtendResult = z.infer<typeof ContestExtendResult>;

/** Hide a problem from contestants (and from the board) or bring it back. */
export const ContestProblemVisibility = z
  .object({ hidden: z.boolean() })
  .strict()
  .meta({ id: 'ContestProblemVisibility' });
export type ContestProblemVisibility = z.infer<typeof ContestProblemVisibility>;

/** IN-02: switch a problem's hidden canary instruction on or off (off by default). */
export const ContestProblemCanary = z
  .object({ enabled: z.boolean() })
  .strict()
  .meta({ id: 'ContestProblemCanary' });
export type ContestProblemCanary = z.infer<typeof ContestProblemCanary>;

export const Rejudge = z
  .object({
    scope: z.enum(['submission', 'problem', 'contest']),
    /** A submission id, a problem id, or a contest id, by scope. */
    id: z.string().uuid(),
    /** Run on the contest lane instead of the rejudge lane. */
    urgent: z.boolean().default(false),
  })
  .strict()
  .meta({ id: 'Rejudge' });
export type Rejudge = z.infer<typeof Rejudge>;

export const RejudgeResult = z
  .object({
    /** Submissions queued for another run. */
    queued: z.number().int().min(0),
    /** Skipped: still being judged, or the job could not be queued. */
    skipped: z.number().int().min(0),
    /** More matched than the limit allows in one go; run it again for the rest. */
    truncated: z.boolean(),
  })
  .strict()
  .meta({ id: 'RejudgeResult' });
export type RejudgeResult = z.infer<typeof RejudgeResult>;

export const OpsSummary = z
  .object({
    serverNow: z.string(),
    /** Jobs waiting per lane (not yet read by a judge). */
    lanes: z.array(z.object({ lane: Lane, depth: z.number().int().min(0) }).strict()),
    workers: z.array(
      z
        .object({
          id: z.string(),
          lanes: z.array(z.string()),
          busy: z.number().int().min(0),
          concurrency: z.number().int().min(0),
          /** Milliseconds since its last heartbeat. */
          ageMs: z.number().int().min(0),
          /** Milliseconds since this process started; null for a worker that does not report it. */
          uptimeMs: z.number().int().min(0).nullable(),
          /** Restarts seen in the last 5 minutes (X-15). */
          restarts5m: z.number().int().min(0),
          /** Milliseconds since the last restart seen in the last 24 hours; null: none. */
          lastRestartAgoMs: z.number().int().min(0).nullable(),
        })
        .strict(),
    ),
    /** Time from submit to verdict over the last 15 minutes (null: nothing judged). */
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    submissionsPerMin: z.number().min(0),
    dlq: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'OpsSummary' });
export type OpsSummary = z.infer<typeof OpsSummary>;

export const DlqEntry = z
  .object({
    entryId: z.string(),
    reason: z.string(),
    error: z.string(),
    lane: z.string(),
    submissionId: z.string().nullable(),
    workerId: z.string(),
    at: z.number().nullable(),
  })
  .strict()
  .meta({ id: 'DlqEntry' });
export type DlqEntry = z.infer<typeof DlqEntry>;

export const DlqList = z
  .object({ items: z.array(DlqEntry) })
  .strict()
  .meta({ id: 'DlqList' });
export type DlqList = z.infer<typeof DlqList>;
