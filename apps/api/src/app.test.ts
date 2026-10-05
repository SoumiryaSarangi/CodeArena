import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { ZodPipe } from './common/zod.pipe';
import { loadConfig } from './config/config';
import { RateLimit } from './rate-limit/rate-limit';

const Body_ = z.object({ n: z.number().int() }).strict();
const scope = `test-${Math.random().toString(36).slice(2)}`;

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

describe('F-05: config', () => {
  it('F-05: invalid configuration is rejected at boot', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/invalid configuration/);
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
    const res = await request(app.getHttpServer())
      .post('/api/t/validated')
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
