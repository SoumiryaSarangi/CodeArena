import { sql } from 'drizzle-orm';
import { problems } from '../../db/schema';

/**
 * FR-PROB-09: the problems practice may show and judge. A public problem, or one set to `contest`
 * visibility once every published contest that includes it has ended. While any published contest
 * that includes it has not ended, it is hidden (404) from practice, whatever its visibility says.
 */
export const practiceVisible = sql`(
  ${problems.visibility} in ('public', 'contest')
  and not exists (
    select 1 from contest_problems cp join contests c on c.id = cp.contest_id
    where cp.problem_id = ${problems.id} and c.status <> 'draft' and c.ends_at > now())
  and (${problems.visibility} = 'public' or exists (
    select 1 from contest_problems cp join contests c on c.id = cp.contest_id
    where cp.problem_id = ${problems.id} and c.status <> 'draft' and c.ends_at <= now()))
)`;
