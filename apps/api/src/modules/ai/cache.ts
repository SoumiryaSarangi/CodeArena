import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';

/** Cache key: SHA-256 over the parts, in order, with an unambiguous separator (SD-§12.2 step 2). */
export const aiCacheKey = (...parts: (string | number)[]) =>
  createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');

/** Normalises code for the cache key: line endings, trailing spaces and surrounding blank lines don't matter. */
export const normaliseCode = (code: string) =>
  code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();

/**
 * The hint cache: a repeated request (same problem version, level, code, last verdict and prompt version)
 * is answered without a model call. JSON values with a time to live; a Redis failure is a miss, not an error.
 */
@Injectable()
export class AiCache {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {}

  private k(key: string) {
    return `${this.prefix}ai:cache:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      await whenReady(this.redis);
      const raw = await this.redis.get(this.k(key));
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlS = 24 * 3600) {
    try {
      await whenReady(this.redis);
      await this.redis.set(this.k(key), JSON.stringify(value), 'EX', ttlS);
    } catch {
      // the cache is an optimisation
    }
  }

  /** The cached value, or compute it, store it and return it. */
  async remember<T>(
    key: string,
    ttlS: number,
    compute: () => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== null) return { value: cached, hit: true };
    const value = await compute();
    await this.set(key, value, ttlS);
    return { value, hit: false };
  }
}
