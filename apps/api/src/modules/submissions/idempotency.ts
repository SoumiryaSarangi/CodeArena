import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ProblemError } from '../../common/problem';
import { REDIS } from '../../redis/redis.module';
import { QUEUE_KEY_PREFIX } from './queue.service';

const TTL_S = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING = '__pending__';

/**
 * FR-SUB-09: the same `Idempotency-Key` from the same user for the same operation, within 10
 * minutes, returns the original response and does the work once. A repeat that arrives while the
 * first is still running waits for it. A failed first attempt releases the key so a retry can run.
 */
@Injectable()
export class Idempotency {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {}

  async once<T>(
    scope: string,
    userId: string,
    key: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return work();
    if (!UUID.test(key)) {
      throw new ProblemError('validation', 'Idempotency-Key must be a UUID', {
        errors: [{ path: 'Idempotency-Key', message: 'must be a UUID' }],
      });
    }
    const k = `${this.prefix}idem:${scope}:${userId}:${key.toLowerCase()}`;
    if ((await this.redis.set(k, PENDING, 'EX', TTL_S, 'NX')) === 'OK') {
      try {
        const result = await work();
        await this.redis.set(k, JSON.stringify(result), 'EX', TTL_S);
        return result;
      } catch (err) {
        await this.redis.del(k);
        throw err;
      }
    }
    for (let i = 0; i < 100; i++) {
      const v = await this.redis.get(k);
      if (v === null) return this.once(scope, userId, key, work); // the first attempt failed: take over
      if (v !== PENDING) return JSON.parse(v) as T;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new ProblemError('rate-limited', 'A request with this Idempotency-Key is still running', {
      headers: { 'Retry-After': '1' },
    });
  }
}
