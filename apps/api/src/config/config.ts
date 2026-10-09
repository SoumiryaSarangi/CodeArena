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
  // Error tracking (O-01); off when unset.
  SENTRY_DSN: z.string().url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  // How many reverse proxies sit in front of the API (Caddy = 1), so `req.ip` is the visitor, not the proxy.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Per signed-in user, for routes without their own limit. */
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().positive().default(120),
  /**
   * Per address, for routes without their own limit when nobody is signed in (X-10). Larger on purpose:
   * a whole campus shares one address, and behind the Vercel rewrite every visitor looks like one of
   * a few Vercel addresses. Abuse that matters is limited per user or per session instead.
   */
  RATE_LIMIT_ANON_PER_MIN: z.coerce.number().int().positive().default(600),
  // Prefix of every queue/stream key. Empty in production; tests set one so they never touch real queues.
  QUEUE_KEY_PREFIX: z.string().max(40).default(''),
  // Q-05: realtime. The bridge copies worker progress into the replay buffer (one leader at a time).
  REALTIME_BRIDGE: z.enum(['on', 'off']).optional(),
  SSE_PING_MS: z.coerce.number().int().min(50).default(15_000),
  SSE_QUEUE_TICK_MS: z.coerce.number().int().min(50).default(2_000),
  BRIDGE_LEASE_MS: z.coerce.number().int().min(300).default(5_000),
  // Q-03b: the reconciler re-enqueues submissions that were accepted but lost their job.
  RECONCILER: z.enum(['on', 'off']).optional(),
  RECONCILER_EVERY_MS: z.coerce.number().int().min(50).default(30_000),
  RECONCILER_STUCK_MS: z.coerce.number().int().min(50).default(120_000),
  // Q-03: whether this instance reads the `results` stream. Default on, except under NODE_ENV=test.
  RESULT_CONSUMER: z.enum(['on', 'off']).optional(),

  // AI layer (AI-01). No key = that provider's models are skipped; no keys at all = AI features answer "busy".
  GROQ_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** JSON overrides of the task → model chains and the daily budgets (see modules/ai/ai.config.ts). */
  /** Where the AI calls go when the providers refuse this server's region: the Vercel relay (apps/web/lib/ai-relay.ts). */
  AI_RELAY_URL: z.union([z.string().url(), z.literal('not-configured')]).optional(),
  AI_RELAY_SECRET: z.union([z.string().min(24), z.literal('not-configured')]).optional(),
  AI_ROUTES: z.string().optional(),
  AI_BUDGETS: z.string().optional(),
  AI_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(25),
  AI_USER_PER_HOUR: z.coerce.number().int().positive().default(30),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_RETRY_MAX_WAIT_MS: z.coerce.number().int().min(0).default(8_000),
  /** AI-03: the background review writer: how often it wakes, and how many reviews it writes each time. */
  AI_REVIEW_EVERY_MS: z.coerce.number().int().min(50).default(60_000),
  AI_REVIEW_PER_TICK: z.coerce.number().int().min(1).default(3),
  // Whether this instance reads the `ai:jobs` stream. Default on, except under NODE_ENV=test.
  AI_WORKER: z.enum(['on', 'off']).optional(),

  // Plagiarism job (PL-05): the shared secret of the plag service. Unset: its endpoints answer 403 "not configured".
  PLAG_SERVICE_TOKEN: z.union([z.string().min(32), z.literal('not-configured')]).optional(),
  // Collab server (CP-01): its own shared secret for the internal authorize call. Unset: that endpoint answers 403.
  COLLAB_SERVICE_TOKEN: z.union([z.string().min(32), z.literal('not-configured')]).optional(),
  /** A run that has been `running` this long without a result is taken over by the next claim (the job died). */
  PLAG_STALE_MINUTES: z.coerce.number().int().min(1).default(30),

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

/** Q-05: should this API instance run the progress bridge? */
export const realtimeBridgeEnabled = (c: Pick<Config, 'NODE_ENV' | 'REALTIME_BRIDGE'>) =>
  (c.REALTIME_BRIDGE ?? (c.NODE_ENV === 'test' ? 'off' : 'on')) === 'on';

/** Q-03b: should this API instance run the reconciler? (Only one runs per sweep, by lease.) */
export const reconcilerEnabled = (c: Pick<Config, 'NODE_ENV' | 'RECONCILER'>) =>
  (c.RECONCILER ?? (c.NODE_ENV === 'test' ? 'off' : 'on')) === 'on';

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
