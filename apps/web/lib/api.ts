import type { AccessToken, ProblemDetails } from '@codearena/contracts';

/** An RFC 7807 failure from the API (SRS §3.1.2); `requestId` is the problem's `instance`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** Seconds from `Retry-After` (429), if the server sent it. */
    readonly retryAfter?: number,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

const GUEST_RECHECK_MS = 30_000;

/** The `ca_csrf` cookie the API sets on every response (double-submit, FR-AUTH-07). */
function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)ca_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The browser's access token: kept in memory only, never in storage. The long-lived part is the
 * httpOnly refresh cookie; `refresh()` trades it for a 15-minute token (FR-AUTH-04/05).
 * Concurrent callers share one refresh, because every refresh rotates the cookie.
 */
export class AuthClient {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string | null> | null = null;
  /** A refused refresh means "signed out": don't ask again on every request. */
  private guestUntil = 0;

  constructor(
    private readonly doFetch: Fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
    private readonly csrf: () => string | null = csrfFromCookie,
  ) {}

  /** A token that is good for at least a minute, refreshing if needed; null when signed out. */
  async accessToken(): Promise<string | null> {
    if (this.token && this.expiresAt - this.now() > 60_000) return this.token;
    if (!this.token && this.now() < this.guestUntil) return null;
    return this.refresh();
  }

  refresh(): Promise<string | null> {
    this.inflight ??= this.runRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the token (sign-out, or a refresh that was refused). */
  clear() {
    this.token = null;
    this.expiresAt = 0;
    this.guestUntil = this.now() + GUEST_RECHECK_MS;
  }

  private async runRefresh(): Promise<string | null> {
    try {
      // The CSRF cookie is set by any response; one cheap GET makes sure we have it.
      let csrf = this.csrf();
      if (!csrf) {
        await this.doFetch('/api/health/live').catch(() => {});
        csrf = this.csrf();
      }
      const res = await this.doFetch('/api/auth/refresh', {
        method: 'POST',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      });
      if (!res.ok) {
        this.clear();
        this.guestUntil = this.now() + GUEST_RECHECK_MS;
        return null;
      }
      this.guestUntil = 0;
      const body = (await res.json()) as AccessToken;
      this.token = body.accessToken;
      this.expiresAt = body.expiresAt;
      return this.token;
    } catch {
      // Offline or the server is down: stay signed in as far as we know, try again next call.
      return this.token;
    }
  }
}

export const auth = new AuthClient();

export interface RequestOptions {
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key`: the same key twice does the work once (FR-SUB-09). */
  idempotencyKey?: string;
  /** `required` fails with 401 for guests before calling; `optional` (default) adds a token if there is one. */
  auth?: 'optional' | 'required';
}

/**
 * Calls the API through the web origin's `/api` rewrite (cookies stay first-party). Adds the bearer
 * token when signed in and the CSRF header on mutations; on a 401 it refreshes the token once and
 * retries. Failures become `ApiError`.
 */
export async function apiFetch<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
  client: AuthClient = auth,
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<T> {
  const send = async (token: string | null) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') {
      const csrf = csrfFromCookie();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    try {
      return await doFetch(`/api${path}`, {
        method,
        headers,
        signal: opts.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
    }
  };

  let token = await client.accessToken();
  if (!token && opts.auth === 'required') {
    throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
  }
  let res = await send(token);
  if (res.status === 401 && token) {
    token = await client.refresh();
    if (token) res = await send(token);
  }
  if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.json()) as T);

  const problem = (await res.json().catch(() => null)) as Partial<ProblemDetails> | null;
  const retry = Number(res.headers.get('Retry-After'));
  throw new ApiError(
    res.status,
    problem?.code ?? 'internal',
    problem?.detail ?? problem?.title ?? 'Something went wrong on our side.',
    problem?.instance,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
    problem?.errors,
  );
}

/** GET with the signed-in user's token when there is one (public data still works for guests). */
export const apiGet = <T>(path: string, signal?: AbortSignal) =>
  apiFetch<T>('GET', path, undefined, { signal });
