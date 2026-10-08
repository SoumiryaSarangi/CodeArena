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
        };
        const ageMs = Math.max(0, now - hb.ts);
        if (ageMs > HEARTBEAT_STALE_MS) continue;
        out.push({
          id: hb.workerId,
          lanes: hb.lanes,
          busy: hb.busy,
          concurrency: hb.concurrency,
          ageMs,
        });
      } catch {
        // a heartbeat we cannot read is not a worker we can show
      }
    }
  } while (cursor !== '0');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
