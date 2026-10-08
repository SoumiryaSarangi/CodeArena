import type { Lane } from '@codearena/contracts';
import type { Redis } from 'ioredis';

const GROUP = 'judges';

/** Jobs waiting in a lane: those the `judges` group has not read yet (the stream length without one). */
export async function laneDepth(redis: Redis, prefix: string, lane: Lane): Promise<number> {
  const key = `${prefix}jobs:${lane}`;
  try {
    const groups = (await redis.xinfo('GROUPS', key)) as unknown[][];
    for (const g of groups) {
      const m: Record<string, unknown> = {};
      for (let i = 0; i < g.length; i += 2) m[String(g[i])] = g[i + 1];
      if (m.name === GROUP && typeof m.lag === 'number') return m.lag;
    }
    return await redis.xlen(key);
  } catch {
    return 0;
  }
}
