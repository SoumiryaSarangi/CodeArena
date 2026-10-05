import type { CookieOptions, Request } from 'express';

export const REFRESH_COOKIE = 'ca_rt';
export const CSRF_COOKIE = 'ca_csrf';
export const OAUTH_COOKIE = 'ca_oauth';

export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000; // FR-AUTH-04, sliding

/** FR-AUTH-06: httpOnly, Secure, SameSite=Lax, scoped to /api/auth. */
export const refreshCookie = (maxAge = REFRESH_TTL_MS): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth',
  maxAge,
});

/** Readable by the web app so it can echo it in X-CSRF-Token (double submit, FR-AUTH-07). */
export const csrfCookie = (): CookieOptions => ({
  httpOnly: false,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 365 * 24 * 3600 * 1000,
});

export const oauthCookie = (): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/callback',
  maxAge: 10 * 60 * 1000,
});

/** Minimal Cookie-header parser; first occurrence of a name wins, malformed values are skipped. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
