import type { ProblemDetails } from '@codearena/contracts';

/** An RFC 7807 failure from the API (SRS §3.1.2); `requestId` is the problem's `instance`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/** GET a JSON resource through the web origin's `/api` rewrite (cookies stay first-party). */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => null)) as Partial<ProblemDetails> | null;
  throw new ApiError(
    res.status,
    body?.code ?? 'internal',
    body?.detail ?? body?.title ?? 'Something went wrong on our side.',
    body?.instance,
  );
}
