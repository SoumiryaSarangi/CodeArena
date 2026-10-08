import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ProblemError } from '../common/problem';
import { CONFIG, type Config } from '../config/config';
import { REDIS } from '../redis/redis.module';
import { readCookie, REFRESH_COOKIE } from '../modules/auth/cookies';
import { LOGGER } from '../telemetry/logger';

export interface RateLimitOptions {
  /** Bucket name, part of the Redis key `{prefix}rl:{scope}:{id}` (the prefix is empty in production; tests set one). */
  scope: string;
  /** Burst size and refill amount per minute. */
  perMinute: number;
  /**
   * Whose bucket. Default: the signed-in user, else the address. `refresh-cookie`: one bucket per
   * refresh-token cookie (a session), so visitors who share an address, or who all arrive through the
   * Vercel rewrite, do not share a limit; without the cookie the anonymous default applies.
   */
  by?: 'refresh-cookie';
}

const META = 'rate-limit';
/** `@RateLimit({scope:'submit', perMinute:6})` or `@RateLimit(false)` to exempt a route. */
export const RateLimit = (opts: RateLimitOptions | false) => SetMetadata(META, opts);

const limited = metrics
  .getMeter('api')
  .createCounter('ca_rate_limited_total', { description: 'Requests rejected by the rate limiter' });

// Atomic token bucket on a hash {tokens, ts}. Uses Redis TIME so API instances need no clock sync.
// Returns {allowed, retryAfterMs}.
const SCRIPT = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) -- tokens per ms
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local h = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(h[1])
local ts = tonumber(h[2])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + (now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate) + 1000)
return {allowed, retry}
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | false | undefined>(META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (opts === false) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    const cookie = opts?.by === 'refresh-cookie' ? readCookie(req, REFRESH_COOKIE) : undefined;
    // Signed in: the user's own bucket. Not signed in: the address, with the larger anonymous default.
    const fallback = {
      scope: 'default',
      perMinute: req.user
        ? this.config.RATE_LIMIT_DEFAULT_PER_MIN
        : this.config.RATE_LIMIT_ANON_PER_MIN,
    };
    const { scope, perMinute } = opts && (opts.by === undefined || cookie) ? opts : fallback;
    const id = cookie
      ? `s:${createHash('sha256').update(cookie).digest('hex').slice(0, 24)}`
      : (req.user?.id ?? req.ip ?? 'unknown');
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const [allowed, retryMs] = (await this.redis.eval(
        SCRIPT,
        1,
        `${this.config.QUEUE_KEY_PREFIX}rl:${scope}:${id}`,
        perMinute,
        perMinute / 60_000,
      )) as [number, number];
      if (allowed === 1) return true;
      limited.add(1, { scope });
      const retryAfter = Math.max(1, Math.ceil(retryMs / 1000));
      throw new ProblemError('rate-limited', `Retry in ${retryAfter}s`, {
        headers: { 'Retry-After': String(retryAfter) },
      });
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      // Fail open: a Redis outage must not take the whole API down. /health/ready reports Redis.
      this.log.warn({ err: e, scope }, 'rate limiter unavailable, allowing request');
      return true;
    }
  }
}
