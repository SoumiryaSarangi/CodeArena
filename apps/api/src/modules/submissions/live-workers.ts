import type { OpsSummary } from '@codearena/contracts';
import type { Redis } from 'ioredis';

/** A heartbeat older than this is a worker that has stopped (the worker writes one every few seconds). */
export const HEARTBEAT_STALE_MS = 60_000;

/** The judge workers that have reported recently, from their `hb:{workerId}` keys, sorted by id. */
export async function liveWorkers(
  redis: Redis,
  prefix: string,
  now: number,
): Promise<OpsSummary['workers']> {
  const out: OpsSummary['workers'] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}hb:*`, 'COUNT', 100);
    cursor = next;
    if (keys.length === 0) continue;
    const values = await redis.mget(keys);
    for (const raw of values) {
      if (!raw) continue;
      try {
        const hb = JSON.parse(raw) as {
          workerId: string;
          lanes: string[];
          ts: number;
          busy: number;
          concurrency: number;
          startedAt?: number;
        };
        const ageMs = Math.max(0, now - hb.ts);
        if (ageMs > HEARTBEAT_STALE_MS) continue;
        out.push({
          id: hb.workerId,
          lanes: hb.lanes,
          busy: hb.busy,
          concurrency: hb.concurrency,
          ageMs,
          uptimeMs: hb.startedAt ? Math.max(0, now - hb.startedAt) : null,
          restarts5m: 0,
          lastRestartAgoMs: null,
        });
      } catch {
        // a heartbeat we cannot read is not a worker we can show
      }
    }
  } while (cursor !== '0');
  for (const w of out) {
    const [recent, last] = await Promise.all([
      redis.zcount(`${prefix}ops:restarts:${w.id}`, now - 5 * 60_000, '+inf'),
      redis.zrevrange(`${prefix}ops:restarts:${w.id}`, 0, 0, 'WITHSCORES'),
    ]);
    w.restarts5m = recent;
    w.lastRestartAgoMs = last[1] ? Math.max(0, now - Number(last[1])) : null;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const DAY_MS = 24 * 3600_000;

/**
 * X-15: a worker that restarts inside its 10 s heartbeat window never goes missing from the list, so
 * its restarts are noticed here instead: a heartbeat whose `startedAt` differs from the one seen
 * before is a restart. Call it every few seconds; it is idempotent (the member is the start time),
 * so several API instances may all run it. History is kept 24 hours.
 */
export async function noteRestarts(redis: Redis, prefix: string, now: number): Promise<number> {
  let found = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}hb:*`, 'COUNT', 100);
    cursor = next;
    if (keys.length === 0) continue;
    for (const raw of await redis.mget(keys)) {
      if (!raw) continue;
      try {
        const hb = JSON.parse(raw) as { workerId?: string; startedAt?: number };
        if (!hb.workerId || !hb.startedAt) continue;
        const boot = `${prefix}ops:boot:${hb.workerId}`;
        const prev = await redis.getset(boot, String(hb.startedAt));
        await redis.expire(boot, 7 * 24 * 3600);
        if (prev !== null && prev !== String(hb.startedAt)) {
          const key = `${prefix}ops:restarts:${hb.workerId}`;
          await redis.zadd(key, hb.startedAt, String(hb.startedAt));
          await redis.zremrangebyscore(key, '-inf', now - DAY_MS);
          await redis.expire(key, 2 * 24 * 3600);
          found++;
        }
      } catch {
        // an unreadable heartbeat is skipped
      }
    }
  } while (cursor !== '0');
  return found;
}
