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
  /**
   * Call the API host itself (`NEXT_PUBLIC_REALTIME_URL`, the same origin the realtime stream uses)
   * instead of the web origin's `/api` rewrite. For bodies the Vercel rewrite should not carry:
   * package uploads and test downloads can be tens of megabytes. Bearer token only, no cookies, so
   * no CSRF header either. Without that variable (dev) it falls back to the rewrite.
   */
  direct?: boolean;
  /**
   * Waits (ms) before each automatic retry of a keyed request that failed because the server was
   * briefly away (no connection, 500, 502, 503, 504). The same `Idempotency-Key` goes with every try, so
   * the work happens once. Only used with `idempotencyKey`; default 1+2+4+8 s (X-14), `[]` turns it off.
   */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const RETRYABLE = new Set([0, 500, 502, 503, 504]);

const apiBase = (direct?: boolean) =>
  direct ? (process.env.NEXT_PUBLIC_REALTIME_URL ?? '').replace(/\/$/, '') : '';

/**
 * Sends a request through the web origin's `/api` rewrite (cookies stay first-party), or directly
 * to the API host with `opts.direct`. Adds the bearer token when signed in and the CSRF header on
 * mutations; on a 401 it refreshes the token once and retries. A body is JSON unless it is
 * `FormData`. Failures become `ApiError`; a success returns the raw response.
 */
async function apiRequest(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  opts: RequestOptions,
  client: AuthClient,
  doFetch: Fetch,
): Promise<Response> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const send = async (token: string | null) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // A multipart body gets its Content-Type (with the boundary) from the browser.
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && !opts.direct) {
      const csrf = csrfFromCookie();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    try {
      return await doFetch(`${apiBase(opts.direct)}/api${path}`, {
        method,
        headers,
        signal: opts.signal,
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
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
  const attempt = async () => {
    let r = await send(token);
    if (r.status === 401 && token) {
      token = await client.refresh();
      if (token) r = await send(token);
    }
    return r;
  };
  const delays = opts.idempotencyKey ? (opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS) : [];
  let res: Response | undefined;
  for (let i = 0; ; i++) {
    let networkError: ApiError | undefined;
    try {
      res = await attempt();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 0) throw err;
      networkError = err;
    }
    const failed = networkError ? 0 : res!.ok ? null : res!.status;
    if (failed === null || !RETRYABLE.has(failed) || i >= delays.length) {
      if (networkError) throw networkError;
      break;
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delays[i]);
      opts.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  if (res!.ok) return res!;

  const problem = (await res!.json().catch(() => null)) as Partial<ProblemDetails> | null;
  const retry = Number(res!.headers.get('Retry-After'));
  throw new ApiError(
    res!.status,
    problem?.code ?? 'internal',
    problem?.detail ?? problem?.title ?? 'Something went wrong on our side.',
    problem?.instance,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
    problem?.errors,
  );
}

/** JSON in, JSON out (see `apiRequest`). */
export async function apiFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
  client: AuthClient = auth,
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<T> {
  const res = await apiRequest(method, path, body, opts, client, doFetch);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** The bytes of a GET (a file download), with the same token handling as every other call. */
export async function apiBlob(
  path: string,
  opts: RequestOptions = {},
  client: AuthClient = auth,
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<{ blob: Blob; filename: string | null }> {
  const res = await apiRequest('GET', path, undefined, opts, client, doFetch);
  const disposition = res.headers.get('Content-Disposition') ?? '';
  return {
    blob: await res.blob(),
    filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? null,
  };
}

/** The bytes of a GET and its headers (the replay's slices carry their sequence range in headers), same token handling. */
export async function apiBinary(
  path: string,
  opts: RequestOptions = {},
  client: AuthClient = auth,
  doFetch: Fetch = (...a) => fetch(...a),
): Promise<{ bytes: ArrayBuffer; headers: Headers }> {
  const res = await apiRequest('GET', path, undefined, opts, client, doFetch);
  return { bytes: await res.arrayBuffer(), headers: res.headers };
}

/** GET with the signed-in user's token when there is one (public data still works for guests). */
export const apiGet = <T>(path: string, signal?: AbortSignal) =>
  apiFetch<T>('GET', path, undefined, { signal });
