import { z } from 'zod';

/** Profile and home (UI-05): SRS FR-RATE-03, UI_UX S03 and S12. */

export const ActivityDay = z.object({ date: z.string(), count: z.number().int().min(1) }).strict();

export const ProfileSummary = z
  .object({
    handle: z.string(),
    avatarUrl: z.string().nullable(),
    rating: z.number().int(),
    joinedAt: z.string(),
    /** Problems with an accepted solution; contest problems count once their contest is over. */
    solved: z
      .object({
        total: z.number().int().min(0),
        byDifficulty: z.array(
          z.object({ label: z.string(), count: z.number().int().min(0) }).strict(),
        ),
        /** The ten tags with the most solved problems. */
        byTag: z.array(z.object({ tag: z.string(), count: z.number().int().min(1) }).strict()),
      })
      .strict(),
    /** Submissions per day over the last 365 days (UTC); days without any are left out. */
    activity: z
      .object({
        from: z.string(),
        to: z.string(),
        total: z.number().int().min(0),
        days: z.array(ActivityDay),
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'ProfileSummary' });
export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const HomeSummary = z
  .object({
    nextContest: z
      .object({
        slug: z.string(),
        title: z.string(),
        startsAt: z.string(),
        endsAt: z.string(),
        state: z.enum(['scheduled', 'running']),
        registered: z.boolean(),
      })
      .strict()
      .nullable(),
    /** The last problems you tried in practice, newest first. */
    continuePracticing: z.array(
      z
        .object({
          slug: z.string(),
          title: z.string(),
          solved: z.boolean(),
          lastVerdict: z.string().nullable(),
        })
        .strict(),
    ),
    /** My AI reviews of the latest finalised contest I took part in (AI-03): how many are written so far. */
    reviews: z
      .object({
        contestSlug: z.string(),
        contestTitle: z.string(),
        ready: z.number().int().min(0),
        total: z.number().int().min(1),
      })
      .strict()
      .nullable(),
    /** Only for someone who has not submitted anything yet: the easiest problems to start with. */
    warmUps: z.array(
      z.object({ slug: z.string(), title: z.string(), difficulty: z.number().int() }).strict(),
    ),
  })
  .strict()
  .meta({ id: 'HomeSummary' });
export type HomeSummary = z.infer<typeof HomeSummary>;
