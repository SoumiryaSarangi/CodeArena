import { z } from 'zod';

/** Error catalogue: SRS §3.1.8. */
export const ErrorCode = z
  .enum([
    'validation',
    'unauthorized',
    'token-reused',
    'forbidden',
    'forbidden-topic',
    'not-found',
    'handle-taken',
    'already-registered',
    'conflict',
    'payload-too-large',
    'unsupported-language',
    'contest-not-started',
    'contest-ended',
    'contest-finished',
    'problem-hidden',
    'hints-disabled-in-contest',
    'hint-level-locked',
    'invalid-package',
    'room-closed',
    'rate-limited',
    'ai-busy',
    'internal',
  ])
  .meta({ id: 'ErrorCode' });
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 7807 `application/problem+json`. */
export const ProblemDetails = z
  .object({
    type: z.string().startsWith('https://codearena.dev/errors/'),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ErrorCode,
    errors: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
  })
  .strict()
  .meta({ id: 'ProblemDetails' });
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Cursor pagination: `{ items, nextCursor }`, limit max 100 (SRS §3.1.2). */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict();
