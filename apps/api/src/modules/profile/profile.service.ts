import type { HomeSummary, ProfileSummary } from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';

const tracer = trace.getTracer('api');
const DAY_MS = 86_400_000;

/**
 * The problems a user has solved, as far as other people may see: an accepted submission that
 * counts (not disqualified) and is either practice or from a contest that has ended, so a profile
 * never shows which contest problem someone has solved while the contest still runs.
 */
const solvedCte = (userId: string) => sql`
  solved as (
    select distinct p.id as pid, p.difficulty
    from submissions s
    join problem_versions v on v.id = s.problem_version_id
    join problems p on p.id = v.problem_id
    left join contests c on c.id = s.contest_id
    where s.user_id = ${userId} and s.verdict = 'AC' and s.disqualified = false
      and (s.contest_id is null or c.ends_at <= now())
  )`;

@Injectable()
export class ProfileService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `GET /users/{handle}/profile` (public). */
  async profile(handle: string): Promise<ProfileSummary> {
    return tracer.startActiveSpan('profile.get', async (span) => {
      try {
        const u = (
          await this.db.execute<{
            id: string;
            handle: string;
            avatar: string | null;
            rating: number;
            at: Date;
          }>(
            sql`select id, handle::text as handle, avatar_url as avatar, rating, created_at as at
                from users where handle = ${handle} and deleted_at is null limit 1`,
          )
        ).rows[0];
        if (!u) throw new ProblemError('not-found', 'No such user');

        const [byDifficulty, byTag, days] = await Promise.all([
          this.db.execute<{ label: string; count: number; ord: number }>(sql`
            with ${solvedCte(u.id)}
            select case when difficulty < 1000 then 'Under 1000'
                        when difficulty < 1400 then '1000–1399'
                        when difficulty < 1800 then '1400–1799'
                        else '1800 and up' end as label,
                   case when difficulty < 1000 then 1 when difficulty < 1400 then 2
                        when difficulty < 1800 then 3 else 4 end as ord,
                   count(*)::int as count
            from solved group by 1, 2 order by 2`),
          this.db.execute<{ tag: string; count: number }>(sql`
            with ${solvedCte(u.id)}
            select t.tag, count(*)::int as count
            from solved join problem_tags t on t.problem_id = solved.pid
            group by t.tag order by count desc, t.tag limit 10`),
          this.db.execute<{ date: string; count: number }>(sql`
            select to_char((created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as date, count(*)::int as count
            from submissions
            where user_id = ${u.id} and created_at > now() - interval '365 days'
            group by 1 order by 1`),
        ]);

        const labels = ['Under 1000', '1000–1399', '1400–1799', '1800 and up'];
        const diff = new Map(byDifficulty.rows.map((r) => [r.label, Number(r.count)]));
        const now = Date.now();
        const act = days.rows.map((r) => ({ date: r.date, count: Number(r.count) }));
        return {
          handle: u.handle,
          avatarUrl: u.avatar,
          rating: u.rating,
          joinedAt: new Date(u.at).toISOString(),
          solved: {
            total: [...diff.values()].reduce((a, b) => a + b, 0),
            byDifficulty: labels.map((label) => ({ label, count: diff.get(label) ?? 0 })),
            byTag: byTag.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })),
          },
          activity: {
            from: new Date(now - 364 * DAY_MS).toISOString().slice(0, 10),
            to: new Date(now).toISOString().slice(0, 10),
            total: act.reduce((a, d) => a + d.count, 0),
            days: act,
          },
        };
      } finally {
        span.end();
      }
    });
  }

  /** `GET /me/home`: the cards of S03 that need the server. */
  async home(userId: string): Promise<HomeSummary> {
    return tracer.startActiveSpan('profile.home', async (span) => {
      try {
        const [next, recent, any] = await Promise.all([
          this.db.execute<{
            slug: string;
            title: string;
            startsAt: Date;
            endsAt: Date;
            running: boolean;
            registered: boolean;
          }>(sql`
            select c.slug, c.title, c.starts_at as "startsAt", c.ends_at as "endsAt",
                   c.starts_at <= now() as running,
                   exists (select 1 from participants p where p.contest_id = c.id and p.user_id = ${userId}) as registered
            from contests c
            where c.status = 'scheduled' and c.ends_at > now()
            order by c.starts_at asc limit 1`),
          this.db.execute<{
            slug: string;
            title: string;
            solved: boolean;
            verdict: string | null;
          }>(sql`
            with last as (
              select p.id as pid, max(s.created_at) as at
              from submissions s
              join problem_versions v on v.id = s.problem_version_id
              join problems p on p.id = v.problem_id
              where s.user_id = ${userId} and s.lane = 'practice'
              group by p.id
              order by max(s.created_at) desc limit 12
            )
            select p.slug, p.title,
                   exists (select 1 from submissions s2 join problem_versions v2 on v2.id = s2.problem_version_id
                           where s2.user_id = ${userId} and v2.problem_id = p.id and s2.verdict = 'AC') as solved,
                   (select s3.verdict::text from submissions s3 join problem_versions v3 on v3.id = s3.problem_version_id
                    where s3.user_id = ${userId} and v3.problem_id = p.id and s3.lane = 'practice'
                    order by s3.created_at desc limit 1) as verdict
            from last join problems p on p.id = last.pid
            where p.visibility in ('public','contest')
              and not exists (select 1 from contest_problems cp join contests c on c.id = cp.contest_id
                              where cp.problem_id = p.id and c.status <> 'draft' and c.ends_at > now())
            order by last.at desc limit 3`),
          this.db.execute<{ n: number }>(
            sql`select count(*)::int as n from submissions where user_id = ${userId} and lane = 'practice'`,
          ),
        ]);

        const n = next.rows[0];
        const fresh = Number(any.rows[0]?.n ?? 0) === 0;
        const warm = fresh
          ? await this.db.execute<{ slug: string; title: string; difficulty: number }>(sql`
              select p.slug, p.title, p.difficulty from problems p
              where p.visibility = 'public'
                and not exists (select 1 from contest_problems cp join contests c on c.id = cp.contest_id
                                where cp.problem_id = p.id and c.status <> 'draft' and c.ends_at > now())
              order by p.difficulty asc, p.title asc limit 5`)
          : { rows: [] as { slug: string; title: string; difficulty: number }[] };

        return {
          nextContest: n
            ? {
                slug: n.slug,
                title: n.title,
                startsAt: new Date(n.startsAt).toISOString(),
                endsAt: new Date(n.endsAt).toISOString(),
                state: n.running ? ('running' as const) : ('scheduled' as const),
                registered: n.registered,
              }
            : null,
          continuePracticing: recent.rows.map((r) => ({
            slug: r.slug,
            title: r.title,
            solved: Boolean(r.solved),
            lastVerdict: r.verdict,
          })),
          warmUps: warm.rows.map((r) => ({
            slug: r.slug,
            title: r.title,
            difficulty: Number(r.difficulty),
          })),
        };
      } finally {
        span.end();
      }
    });
  }
}
