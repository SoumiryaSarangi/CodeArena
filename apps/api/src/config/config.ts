import { z } from 'zod';
import { DEV_DATABASE_URL } from '../db/client';

// Dev defaults match docker-compose.yml. Production sets every value explicitly (SD-§18.1).
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url().default(DEV_DATABASE_URL),
  REDIS_URL: z.string().url().default('redis://admin:codearena-dev@localhost:6379'),
  S3_ENDPOINT: z.string().url().default('http://localhost:8333'),
  S3_BUCKET_TESTS: z.string().min(1).default('codearena'),
  S3_ACCESS_KEY: z.string().default('codearena'),
  S3_SECRET_KEY: z.string().default('codearena-dev'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    // No silent dev credentials in production: these must be set explicitly.
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'S3_SECRET_KEY'] as const) {
      if (env[key] === undefined)
        throw new Error(`invalid configuration: ${key} is required in production`);
    }
  }
  return parsed.data;
}

export const CONFIG = Symbol('CONFIG');
