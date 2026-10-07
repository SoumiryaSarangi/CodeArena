import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { ZodPipe } from './common/zod.pipe';
import { loadConfig } from './config/config';
import { RateLimit } from './rate-limit/rate-limit';
import { Public } from './modules/auth/guards';

const Body_ = z.object({ n: z.number().int() }).strict();
const scope = `test-${Math.random().toString(36).slice(2)}`;

@Public()
@Controller('t')
class TestController {
  @Post('validated')
  validated(@Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>) {
    return body;
  }
  @Get('boom')
  boom(): never {
    throw new Error('secret database password leaked here');
  }
  @Get('ip')
  ip(@Req() req: Request) {
    return { ip: req.ip };
  }
  @Get('limited')
  @RateLimit({ scope, perMinute: 3 })
  limited() {
    return { ok: true };
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const redisUp = await new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 })
  .connect()
  .then(() => true)
  .catch(() => false);

if (process.env.CI && !redisUp) throw new Error('CI requires the dev stack (scripts/dev-up.sh)');

describe('D-02: behind a reverse proxy', () => {
  const ipOf = async (trust: string | undefined) => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        ...(trust ? { TRUST_PROXY: trust } : {}),
      }),
      [TestModule],
    );
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .get('/api/t/ip')
        .set('X-Forwarded-For', '203.0.113.9');
      return res.body.ip as string;
    } finally {
      await app.close();
    }
  };

  it('D-02: with TRUST_PROXY=1 the visitor address comes from X-Forwarded-For (rate limits see the visitor)', async () => {
    expect(await ipOf('1')).toBe('203.0.113.9');
  });

  it('D-02: by default the header is ignored, so a client cannot fake its address', async () => {
    expect(await ipOf(undefined)).not.toBe('203.0.113.9');
  });

  it('D-02: TRUST_PROXY must be a small whole number', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '9' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
  });
});

describe('F-05: config', () => {
  it('F-05: invalid configuration is rejected at boot', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/invalid configuration/);
  });

  it('F-06: production refuses OAuth endpoint overrides and missing keys', () => {
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db:5432/x',
      REDIS_URL: 'redis://u:p@r:6379',
      S3_SECRET_KEY: 's',
      JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----',
      JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nx\\n-----END PUBLIC KEY-----',
      WEB_URL: 'https://codearena.me',
      PUBLIC_API_URL: 'https://codearena.me',
      OAUTH_GOOGLE_CLIENT_ID: 'g',
      OAUTH_GOOGLE_CLIENT_SECRET: 'g',
      OAUTH_GITHUB_CLIENT_ID: 'h',
      OAUTH_GITHUB_CLIENT_SECRET: 'h',
    };
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, OAUTH_GOOGLE_TOKEN_URL: 'http://evil.test/token' })).toThrow(
      /not allowed in production/,
    );
    expect(() => loadConfig({ ...prod, JWT_PRIVATE_KEY: undefined })).toThrow(
      /JWT_PRIVATE_KEY is required/,
    );
  });

  it('F-06: blank .env values fall back to defaults instead of failing boot', () => {
    const c = loadConfig({
      JWT_ISSUER: '',
      WEB_URL: ' ',
      OAUTH_GITHUB_CLIENT_ID: '',
      JWT_PRIVATE_KEY: '',
    });
    expect(c.JWT_ISSUER).toBe('codearena');
    expect(c.WEB_URL).toBe('http://localhost:3000');
    expect(c.OAUTH_GITHUB_CLIENT_ID).toBeUndefined();
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: '' })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it('F-05: production refuses dev credentials', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is required/);
  });
});

describe('F-05: http conventions', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(config, [TestModule]);
    await app.init();
  });
  afterAll(() => app.close());

  it('F-05: errors are RFC 7807 problem+json with the request id as instance', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/nope')
      .set('X-Request-Id', 'req-12345678');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: 'https://codearena.dev/errors/not-found',
      status: 404,
      code: 'not-found',
      instance: 'req-12345678',
    });
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('F-05: a request id is minted when none (or a malformed one) is sent', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/live')
      .set('X-Request-Id', 'bad id!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('F-05: Zod failures become 400 validation with errors[]; unknown fields are rejected', async () => {
    const csrf = 'c'.repeat(43);
    const res = await request(app.getHttpServer())
      .post('/api/t/validated')
      .set('Cookie', `ca_csrf=${csrf}`)
      .set('X-CSRF-Token', csrf)
      .send({ n: 'x', extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation');
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('F-05: unexpected errors are 500 internal and never leak the cause', async () => {
    const res = await request(app.getHttpServer()).get('/api/t/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('F-05: malformed JSON is a 400 and oversize bodies are 413', async () => {
    const bad = await request(app.getHttpServer())
      .post('/api/t/validated')
      .set('Content-Type', 'application/json')
      .send('{nope');
    expect(bad.status).toBe(400);
    const big = await request(app.getHttpServer())
      .post('/api/t/validated')
      .send({ n: 1, pad: 'x'.repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('payload-too-large');
  });

  it('F-05: /docs is not served outside development', async () => {
    expect((await request(app.getHttpServer()).get('/docs')).status).toBe(404);
  });

  it('F-05: liveness needs no dependencies', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/live');
    expect(res.body).toEqual({ status: 'ok', service: 'api' });
  });

  describe.skipIf(!redisUp)('with the dev stack (docker compose)', () => {
    it('F-05: /health reports DB, Redis and S3', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect(res.body).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok', s3: 'ok' } });
      expect(res.status).toBe(200);
    });

    it('NFR-SEC-06: the token bucket returns 429 with Retry-After once drained', async () => {
      const server = app.getHttpServer();
      for (let i = 0; i < 3; i++)
        expect((await request(server).get('/api/t/limited')).status).toBe(200);
      const res = await request(server).get('/api/t/limited');
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate-limited');
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });
  });
});
