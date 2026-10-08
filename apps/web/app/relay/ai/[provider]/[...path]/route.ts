import { relayAi } from '@/lib/ai-relay';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// AI egress relay for the API (see lib/ai-relay.ts). Only POST exists; every other method is a 405.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string; path: string[] }> },
) {
  return relayAi(req, await ctx.params);
}
