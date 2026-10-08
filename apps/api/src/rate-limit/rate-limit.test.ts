import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { loadConfig } from '../config/config';
import { createTestDatabase, postgresReachable } from '../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../modules/auth/keys';

const redisUp = await new Redis(loadConfig({ NODE_ENV: 'test' }).REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
})
  .connect()
  .then(() => true)
  .catch(() => false);
const ready = redisUp && (await postgresReachable());
const prefix = `t${randomBytes(4).toString('hex')}:`;
const csrf = randomBytes(32).toString('base64url');

describe.skipIf(!ready)(
  'X-10: limits that do not punish a whole campus or the Vercel rewrite (needs Postgres and Redis)',
  () => {
    let app: INestApplication;
    let drop: () => Promise<void>;
    let redis: Redis;
    let tokens: AccessTokens;

    beforeAll(async () => {
      const t = await createTestDatabase();
      drop = t.drop;
      const cfg = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: t.url,
        QUEUE_KEY_PREFIX: prefix,
        // Small on purpose, so the tests can reach the limits.
        RATE_LIMIT_ANON_PER_MIN: '5',
        RATE_LIMIT_DEFAULT_PER_MIN: '2',
      });
      redis = new Redis(cfg.REDIS_URL);
      app = await createApp(cfg);
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      // The guard connects to Redis on its first use and lets that first request through; spend it on
      // a user nobody else uses, so the tests below count exactly.
      const warm = await tokens.sign({
        sub: '00000000-0000-4000-8000-0000000000aa',
        role: 'user',
        sid: '00000000-0000-4000-8000-0000000000ab',
      });
      await request(app.getHttpServer())
        .get('/api/contests')
        .set('Authorization', `Bearer ${warm.token}`);
    });
    afterAll(async () => {
      await app?.close();
      const keys = redis ? await redis.keys(`${prefix}rl:*`) : [];
      if (keys.length) await redis.del(...keys);
      redis?.disconnect();
      await drop?.();
    });

    const get = (path: string, token?: string) => {
      const r = request(app.getHttpServer()).get(path);
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const refresh = (cookie?: string) =>
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `ca_csrf=${csrf}${cookie ? `; ca_rt=${cookie}` : ''}`)
        .set('X-CSRF-Token', csrf);

    it('FR-RT-01: a signed-out visitor gets the anonymous bucket (5 here), a signed-in user their own (2 here)', async () => {
      const burst = async (token?: string) => {
        const codes: number[] = [];
        for (let i = 0; i < 7; i++) codes.push((await get('/api/contests', token)).status);
        return codes;
      };
      expect(await burst()).toEqual([200, 200, 200, 200, 200, 429, 429]);
      const { token } = await tokens.sign({
        sub: '00000000-0000-4000-8000-000000000001',
        role: 'user',
        sid: '00000000-0000-4000-8000-000000000002',
      });
      expect(await burst(token)).toEqual([200, 200, 429, 429, 429, 429, 429]);
    });

    it('X-10: the live-update stream is not limited per address (200 listeners share one campus address)', async () => {
      // The address's anonymous bucket is already empty from the test above, and still nothing is refused
      // for being too many: a bad ticket is a plain 401.
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) {
        codes.push((await get('/api/sse?ticket=bad&topics=sys')).status);
      }
      expect(new Set(codes)).toEqual(new Set([401]));
    });

    it('X-10: refreshing a session is limited per session, not per address', async () => {
      const a: number[] = [];
      for (let i = 0; i < 31; i++) a.push((await refresh('session-a-token')).status);
      expect(a.slice(0, 30)).toEqual(Array(30).fill(401)); // an unknown token is refused, not limited
      expect(a[30]).toBe(429); // the 31st in a minute for this session
      // Another session from the very same address is not affected.
      expect((await refresh('session-b-token')).status).toBe(401);
    });

    it('X-10: a refresh without a session cookie falls back to the anonymous address bucket', async () => {
      // That bucket is empty after the first test: this is limited, but not by the 30-a-minute session rule.
      const r = await refresh();
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('rate-limited');
    });
  },
);
