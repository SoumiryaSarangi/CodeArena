import { z } from 'zod';

/** The plagiarism job's API (PL-05): SRS §3.1.2, SD-§13. Dates are ISO strings. */

export const PlagRunStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type PlagRunStatus = z.infer<typeof PlagRunStatus>;

/** POST /api/admin/plag/runs */
export const PlagRunCreate = z
  .object({
    contestId: z.uuid(),
    /** Passed to the job as it is (thresholds, `embedOn`...); the API does not interpret it. */
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .meta({ id: 'PlagRunCreate' });
export type PlagRunCreate = z.infer<typeof PlagRunCreate>;

/** What a reviewer decided about a cluster (PL-04): never an automatic penalty. `open` = no decision yet. */
export const PlagDecision = z.enum(['clear', 'confirm', 'discuss']);
export type PlagDecision = z.infer<typeof PlagDecision>;
export const PlagClusterStatus = z.enum(['open', 'clear', 'confirm', 'discuss']);
export type PlagClusterStatus = z.infer<typeof PlagClusterStatus>;

export const PlagClusterSummary = z
  .object({
    id: z.uuid(),
    problemId: z.uuid(),
    problemSlug: z.string(),
    size: z.number().int().min(2),
    maxScore: z.number(),
    /** The latest decision, `open` while there is none. */
    status: PlagClusterStatus,
  })
  .strict()
  .meta({ id: 'PlagClusterSummary' });
export type PlagClusterSummary = z.infer<typeof PlagClusterSummary>;

export const PlagRun = z
  .object({
    id: z.uuid(),
    contestId: z.uuid(),
    status: PlagRunStatus,
    params: z.record(z.string(), z.unknown()).nullable(),
    metrics: z.record(z.string(), z.unknown()).nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    /** Strongest first; empty until the run is done. */
    clusters: z.array(PlagClusterSummary),
  })
  .strict()
  .meta({ id: 'PlagRun' });
export type PlagRun = z.infer<typeof PlagRun>;

export const PlagRunList = z
  .object({ items: z.array(PlagRun.omit({ clusters: true })) })
  .strict()
  .meta({ id: 'PlagRunList' });
export type PlagRunList = z.infer<typeof PlagRunList>;

/** What the job is given when it claims a run: the final submissions per problem (SD-§13.1 step 1). */
export const PlagClaim = z
  .object({
    runId: z.uuid(),
    params: z.record(z.string(), z.unknown()),
    problems: z.array(
      z
        .object({
          problemId: z.uuid(),
          slug: z.string(),
          /** Setter-provided starting code that is never evidence (none stored yet). */
          templates: z.array(z.object({ language: z.string(), source: z.string() }).strict()),
          submissions: z.array(
            z
              .object({
                id: z.uuid(),
                language: z.string(),
                source: z.string(),
                /** An opaque id so one person is never compared with themselves; no handle, no e-mail. */
                user: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'PlagClaim' });
export type PlagClaim = z.infer<typeof PlagClaim>;

/** POST /api/admin/plag/runs/{id}/results (service token): the payload of `plag.payload.to_payload`. */
export const PlagResults = z
  .object({
    runId: z.uuid(),
    params: z.record(z.string(), z.unknown()).optional(),
    problems: z.array(
      z
        .object({
          problemId: z.uuid(),
          pairs: z.array(
            z
              .object({
                subA: z.uuid(),
                subB: z.uuid(),
                fpScore: z.number().min(0).max(1),
                embScore: z.number().min(-1).max(1),
                combined: z.number().min(0).max(1),
              })
              .strict(),
          ),
          clusters: z.array(
            z
              .object({
                submissionIds: z.array(z.uuid()).min(2),
                maxScore: z.number().min(0).max(1),
              })
              .strict(),
          ),
          metrics: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'PlagResults' });
export type PlagResults = z.infer<typeof PlagResults>;

/** POST /api/admin/plag/runs/{id}/fail (service token) */
export const PlagFail = z
  .object({ error: z.string().min(1).max(1000) })
  .strict()
  .meta({ id: 'PlagFail' });
export type PlagFail = z.infer<typeof PlagFail>;

/** POST /api/admin/plag/clusters/{id}/decisions: a note is required (FR-PLAG-05). */
export const PlagDecisionCreate = z
  .object({ decision: PlagDecision, note: z.string().trim().min(3).max(2000) })
  .strict()
  .meta({ id: 'PlagDecisionCreate' });
export type PlagDecisionCreate = z.infer<typeof PlagDecisionCreate>;

/** GET /api/admin/plag/clusters/{id}: everything the review screen (S17) shows. Admin only: handles are visible here. */
export const PlagClusterDetail = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    contestId: z.uuid(),
    problemId: z.uuid(),
    problemSlug: z.string(),
    maxScore: z.number(),
    status: PlagClusterStatus,
    members: z.array(
      z
        .object({
          submissionId: z.uuid(),
          handle: z.string(),
          language: z.string(),
          verdict: z.string().nullable(),
          submittedAt: z.string(),
          source: z.string(),
        })
        .strict(),
    ),
    pairs: z.array(
      z
        .object({
          subA: z.uuid(),
          subB: z.uuid(),
          fpScore: z.number().nullable(),
          embScore: z.number().nullable(),
          combined: z.number(),
        })
        .strict(),
    ),
    /** One entry per member. Advisory only (SD-§14, IN-01): never evidence on its own, never used for a score. */
    signals: z.array(
      z
        .object({
          handle: z.string(),
          /** Pastes above 50 characters on this problem. */
          pastes: z.array(z.object({ size: z.number().int(), at: z.string() }).strict()),
          /** Times the window lost focus or the tab was hidden on this problem. */
          focusLosses: z.number().int(),
          openedAt: z.string().nullable(),
          /** Minutes from opening the problem to the first accepted submission; null if either is missing. */
          timeToAcMinutes: z.number().int().nullable(),
          /** 0 = writes like their earlier programs, 1 = nothing alike; null without enough earlier programs. */
          styleShift: z.number().min(0).max(1).nullable(),
        })
        .strict(),
    ),
    decisions: z.array(
      z
        .object({
          id: z.uuid(),
          decision: PlagDecision,
          note: z.string(),
          reviewer: z.string(),
          createdAt: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'PlagClusterDetail' });
export type PlagClusterDetail = z.infer<typeof PlagClusterDetail>;
