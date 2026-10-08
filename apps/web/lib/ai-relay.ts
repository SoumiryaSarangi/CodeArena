import { timingSafeEqual } from 'node:crypto';

/**
 * AI egress relay. Groq and Google AI Studio refuse calls from the API VM's region (Azure East Asia), so the
 * API sends its model calls here instead and this function, running in a supported region, forwards them.
 * It is a narrow forwarder, not a proxy: two fixed upstream hosts, one allowed path shape each, POST only,
 * a shared secret on every call, a body size cap, and it never logs or stores a body (they hold student code).
 * The provider's key travels with the request (Authorization / x-goog-api-key) and is passed through; it is
 * never read from or kept here.
 */

export const MAX_BODY_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;

interface Provider {
  host: string;
  /** The only path shape allowed after the host. */
  path: RegExp;
  /** The request headers handed to the provider. */
  forward: string[];
}

const PROVIDERS: Record<string, Provider> = {
  groq: {
    host: 'https://api.groq.com',
    path: /^openai\/v1\/chat\/completions$/,
    forward: ['authorization', 'content-type'],
  },
  gemini: {
    host: 'https://generativelanguage.googleapis.com',
    path: /^v1beta\/models\/[A-Za-z0-9._-]{1,80}:generateContent$/,
    forward: ['x-goog-api-key', 'content-type'],
  },
};

const text = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Constant-time comparison of the shared secret. */
function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RelayEnv {
  AI_RELAY_SECRET?: string;
}

export async function relayAi(
  req: Request,
  route: { provider: string; path: string[] },
  env: RelayEnv = process.env as RelayEnv,
  doFetch: typeof fetch = (...a) => fetch(...a),
): Promise<Response> {
  const secret = env.AI_RELAY_SECRET;
  // Not configured: refuse everything, so a missing variable never means "open".
  if (!secret || secret.length < 24) return text(503, 'relay is not configured');
  if (!sameSecret(req.headers.get('x-relay-secret'), secret)) return text(401, 'unauthorized');

  const provider = PROVIDERS[route.provider];
  const path = route.path.join('/');
  if (!provider || !provider.path.test(path)) return text(404, 'not found');

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return text(413, 'body too large');
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return text(413, 'body too large');

  const headers = new Headers();
  for (const name of provider.forward) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  let upstream: Response;
  try {
    upstream = await doFetch(`${provider.host}/${path}`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return text(502, 'upstream unreachable');
  }
  const out = new Headers({ 'cache-control': 'no-store' });
  for (const name of ['content-type', 'retry-after']) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
