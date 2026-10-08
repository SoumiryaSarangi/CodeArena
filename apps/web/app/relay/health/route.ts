export const dynamic = 'force-dynamic';

// Which Vercel region the relay runs in (the AI providers must accept it); no secrets, no upstream call.
export async function GET() {
  return Response.json({ ok: true, region: process.env.VERCEL_REGION ?? null });
}
