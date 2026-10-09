import { z } from 'zod';
import { JudgeJob, JudgeProgress, JudgeResult, TestOutcome } from './judge';

export * from './enums';
export * from './judge';
export * from './http';
export * from './sse';
export * from './auth';
export * from './problems';
export * from './submissions';
export * from './admin';
export * from './contests';
export * from './ops';
export * from './ratings';
export * from './status';
export * from './profile';
export * from './hints';
export * from './reviews';
export * from './plag';
export * from './signals';
export * from './collab';
export * from './rooms';

export const HealthSchema = z.object({ status: z.literal('ok'), service: z.string() });
export type Health = z.infer<typeof HealthSchema>;

/** Schemas whose shapes cross into Go; `pnpm contracts:gen` emits these. */
export const wireSchemas = { JudgeJob, JudgeProgress, JudgeResult, TestOutcome } as const;
