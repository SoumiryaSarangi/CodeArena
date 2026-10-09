import { CollabIdentity } from '@codearena/contracts';

export interface ApiLink {
  /** Where the API listens for internal calls, e.g. `http://api:4000`. */
  url: string;
  /** `COLLAB_SERVICE_TOKEN`: the shared secret, sent as `X-Service-Token`. */
  token: string;
  timeoutMs?: number;
}

export type AuthResult =
  | { ok: true; identity: CollabIdentity }
  | { ok: false; reason: 'refused' | 'unreachable' | 'bad-answer' };

/**
 * FR-PAD-03: hand the ticket to the API, which redeems it and says who it is. Anything but a clean 200 with a valid
 * identity is a refusal: a down API never means "let them in".
 */
export async function authorizeTicket(
  api: ApiLink,
  roomId: string,
  ticket: string,
): Promise<AuthResult> {
  let res: Response;
  try {
    res = await fetch(`${api.url.replace(/\/$/, '')}/api/internal/rooms/${roomId}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': api.token },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(api.timeoutMs ?? 3000),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'refused' };
  }
  const parsed = CollabIdentity.safeParse(await res.json().catch(() => null));
  return parsed.success ? { ok: true, identity: parsed.data } : { ok: false, reason: 'bad-answer' };
}
