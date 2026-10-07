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

export const HealthSchema = z.object({ status: z.literal('ok'), service: z.string() });
export type Health = z.infer<typeof HealthSchema>;

/** Schemas whose shapes cross into Go; `pnpm contracts:gen` emits these. */
export const wireSchemas = { JudgeJob, JudgeProgress, JudgeResult, TestOutcome } as const;
