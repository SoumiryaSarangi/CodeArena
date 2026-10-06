import { z } from 'zod';
import { DEV_DATABASE_URL } from '../db/client';

const pem = z
  .string()
  .transform((v) => v.replace(/\\n/g, '\n').trim())
  .refine((v) => v.startsWith('-----BEGIN '), 'must be a PEM block');

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
  // Q-03: whether this instance reads the `results` stream. Default on, except under NODE_ENV=test.
  RESULT_CONSUMER: z.enum(['on', 'off']).optional(),

  // Auth (F-06). PEM keys may arrive as one line with literal "\n" (scripts/gen-keys.sh output).
  JWT_PRIVATE_KEY: pem.optional(),
  JWT_PUBLIC_KEY: pem.optional(),
  JWT_ISSUER: z.string().min(1).default('codearena'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  // Provider endpoint overrides exist for tests (fake provider); refused in production.
  OAUTH_GOOGLE_AUTH_URL: z.string().url().optional(),
  OAUTH_GOOGLE_TOKEN_URL: z.string().url().optional(),
  OAUTH_GOOGLE_JWKS_URL: z.string().url().optional(),
  OAUTH_GOOGLE_ISSUER: z.string().min(1).optional(),
  OAUTH_GITHUB_AUTH_URL: z.string().url().optional(),
  OAUTH_GITHUB_TOKEN_URL: z.string().url().optional(),
  OAUTH_GITHUB_API_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

/** Q-03: should this API instance consume judge results? */
export const resultConsumerEnabled = (c: Pick<Config, 'NODE_ENV' | 'RESULT_CONSUMER'>) =>
  (c.RESULT_CONSUMER ?? (c.NODE_ENV === 'test' ? 'off' : 'on')) === 'on';

export function loadConfig(raw: Record<string, string | undefined> = process.env): Config {
  // `KEY=` in a .env file means "not set": treat blank values like missing so defaults apply.
  const env = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    // No silent dev credentials in production: these must be set explicitly.
    const required = [
      'DATABASE_URL',
      'REDIS_URL',
      'S3_SECRET_KEY',
      'JWT_PRIVATE_KEY',
      'JWT_PUBLIC_KEY',
      'WEB_URL',
      'PUBLIC_API_URL',
      'OAUTH_GOOGLE_CLIENT_ID',
      'OAUTH_GOOGLE_CLIENT_SECRET',
      'OAUTH_GITHUB_CLIENT_ID',
      'OAUTH_GITHUB_CLIENT_SECRET',
    ] as const;
    for (const key of required) {
      if (env[key] === undefined)
        throw new Error(`invalid configuration: ${key} is required in production`);
    }
    const overrides = Object.keys(env).filter((k) =>
      /^OAUTH_\w+_(AUTH|TOKEN|JWKS|API)_URL$|^OAUTH_GOOGLE_ISSUER$/.test(k),
    );
    if (overrides.length > 0)
      throw new Error(`invalid configuration: ${overrides.join(', ')} not allowed in production`);
  }
  return parsed.data;
}

export const CONFIG = Symbol('CONFIG');
