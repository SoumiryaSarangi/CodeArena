import type { Redis } from 'ioredis';

/**
 * The shared client is lazy and has no offline queue, so a command sent while it is still
 * connecting fails at once. Await this first: it starts the connection if nobody has, and waits
 * (up to `timeoutMs`) for it to be ready. It rejects if Redis does not come up in time.
 */
export async function whenReady(redis: Redis, timeoutMs = 3000): Promise<void> {
  if (redis.status === 'ready') return;
  if (redis.status === 'wait') redis.connect().catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      redis.off('ready', ok);
      reject(new Error('Redis is not ready'));
    }, timeoutMs);
    const ok = () => {
      clearTimeout(t);
      resolve();
    };
    redis.once('ready', ok);
    if (redis.status === 'ready') ok();
  });
}
