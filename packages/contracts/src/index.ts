import { z } from 'zod';

export const HealthSchema = z.object({ status: z.literal('ok'), service: z.string() });
export type Health = z.infer<typeof HealthSchema>;
