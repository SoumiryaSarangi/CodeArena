import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';
import type { Budget } from './ai.config';
import type { Usage } from './types';

const DAY_TTL_S = 2 * 24 * 3600;

/** Budget check and reserve in one step, so two requests cannot both spend the last tokens. */
const RESERVE = `
local t = tonumber(redis.call('GET', KEYS[1]) or '0')
local r = tonumber(redis.call('GET', KEYS[2]) or '0')
if t + tonumber(ARGV[1]) > tonumber(ARGV[2]) or r + 1 > tonumber(ARGV[3]) then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;

/** UTC day, the same boundary the providers reset their daily limits on. */
export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * The AI ledger (FR-AI-06, FR-AI-10): per-model daily token and request budgets, cool-downs after a
 * provider asks us to wait, rate-limit windows, and token accounting per feature. All in Redis.
 */
@Injectable()
export class AiLedger {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {}

  private k(...parts: (string | number)[]) {
    return `${this.prefix}ai:${parts.join(':')}`;
  }

  /** Reserves `tokens` and one request against today's budget; false when either would be exceeded. */
  async reserve(model: string, tokens: number, budget: Budget, now = Date.now()): Promise<boolean> {
    await whenReady(this.redis);
    const day = dayKey(now);
    const ok = await this.redis.eval(
      RESERVE,
      2,
      this.k('budget', model, day, 'tokens'),
      this.k('budget', model, day, 'requests'),
      tokens,
      budget.tokensPerDay,
      budget.requestsPerDay,
      DAY_TTL_S,
    );
    return ok === 1;
  }

  /** The call finished: replace the estimate by what the provider reported. */
  async settle(model: string, reserved: number, actual: number, now = Date.now()) {
    if (actual === reserved) return;
    await this.redis.incrby(this.k('budget', model, dayKey(now), 'tokens'), actual - reserved);
  }

  /** The call never happened (failed before any tokens were spent): give the reservation back. */
  async release(model: string, reserved: number, now = Date.now()) {
    const day = dayKey(now);
    await this.redis.incrby(this.k('budget', model, day, 'tokens'), -reserved);
    await this.redis.decr(this.k('budget', model, day, 'requests'));
  }

  async used(model: string, now = Date.now()): Promise<{ tokens: number; requests: number }> {
    await whenReady(this.redis);
    const day = dayKey(now);
    const [t, r] = await this.redis.mget(
      this.k('budget', model, day, 'tokens'),
      this.k('budget', model, day, 'requests'),
    );
    return { tokens: Number(t ?? 0), requests: Number(r ?? 0) };
  }

  /** The provider told us to wait: skip this model until then (shared by every API instance). */
  async coolDown(model: string, ms: number) {
    await this.redis.set(this.k('cool', model), '1', 'PX', Math.max(1, Math.ceil(ms)));
  }

  async isCooling(model: string): Promise<boolean> {
    return (await this.redis.exists(this.k('cool', model))) === 1;
  }

  /**
   * Fixed-window counter: true if this call is within `limit` per `windowS` for `key`, else false with
   * the seconds until the window resets.
   */
  async take(
    scope: string,
    key: string,
    limit: number,
    windowS: number,
    now = Date.now(),
  ): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
    await whenReady(this.redis);
    const window = Math.floor(now / 1000 / windowS);
    const k = this.k('rl', scope, key, window);
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, windowS * 2);
    if (n <= limit) return { ok: true };
    return { ok: false, retryAfterS: Math.max(1, (window + 1) * windowS - Math.floor(now / 1000)) };
  }

  /** Uses made so far in the current window of a `take` counter (for "N left this hour"). */
  async count(scope: string, key: string, windowS: number, now = Date.now()): Promise<number> {
    await whenReady(this.redis);
    const window = Math.floor(now / 1000 / windowS);
    return Number((await this.redis.get(this.k('rl', scope, key, window))) ?? 0);
  }

  /** A short exclusive lock (one generation at a time per user, problem and level). */
  async tryLock(key: string, ttlS: number): Promise<boolean> {
    await whenReady(this.redis);
    return (await this.redis.set(this.k('lock', key), '1', 'EX', ttlS, 'NX')) === 'OK';
  }

  async isLocked(key: string): Promise<boolean> {
    await whenReady(this.redis);
    return (await this.redis.exists(this.k('lock', key))) === 1;
  }

  async unlock(key: string) {
    await this.redis.del(this.k('lock', key));
  }

  /** Token accounting per feature, model and day (FR-AI-10). */
  async account(feature: string, model: string, usage: Usage, now = Date.now()) {
    const k = this.k('usage', dayKey(now));
    await this.redis
      .multi()
      .hincrby(k, `${feature}|${model}|in`, usage.inputTokens)
      .hincrby(k, `${feature}|${model}|out`, usage.outputTokens)
      .hincrby(k, `${feature}|${model}|calls`, 1)
      .expire(k, DAY_TTL_S * 7)
      .exec();
  }

  /** Today's accounting: feature → model → { in, out, calls }. */
  async usageToday(now = Date.now()) {
    await whenReady(this.redis);
    const raw = await this.redis.hgetall(this.k('usage', dayKey(now)));
    const out: Record<string, Record<string, { in: number; out: number; calls: number }>> = {};
    for (const [field, v] of Object.entries(raw)) {
      const [feature, model, what] = field.split('|') as [string, string, 'in' | 'out' | 'calls'];
      ((out[feature] ??= {})[model] ??= { in: 0, out: 0, calls: 0 })[what] = Number(v);
    }
    return out;
  }
}
