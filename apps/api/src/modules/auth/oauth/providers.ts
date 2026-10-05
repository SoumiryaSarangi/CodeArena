import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from '../../../config/config';
import type { OAuthProfile } from '../../users/users.service';

export type ProviderId = 'google' | 'github';

export interface AuthorizeParams {
  state: string;
  challenge: string;
  nonce: string;
  redirectUri: string;
}

export interface ExchangeParams {
  code: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
}

export interface OAuthProvider {
  id: ProviderId;
  configured: boolean;
  authorizeUrl(p: AuthorizeParams): string;
  /** Code → verified profile. Throws on any failure, including an unverified email. */
  exchange(p: ExchangeParams): Promise<OAuthProfile>;
}

const TIMEOUT_MS = 10_000;

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  return res.json();
}

const GoogleToken = z.object({ id_token: z.string() });
const GoogleIdToken = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.literal(true, { message: 'email not verified' }),
  nonce: z.string(),
  name: z.string().optional(),
  picture: z.string().url().optional(),
});

/** Google via OpenID Connect: the id_token is verified against Google's JWKS (iss, aud, nonce). */
export function google(config: Config): OAuthProvider {
  const clientId = config.OAUTH_GOOGLE_CLIENT_ID ?? '';
  const authUrl = config.OAUTH_GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
  const tokenUrl = config.OAUTH_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
  const jwks = createRemoteJWKSet(
    new URL(config.OAUTH_GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs'),
  );
  const issuer = config.OAUTH_GOOGLE_ISSUER
    ? [config.OAUTH_GOOGLE_ISSUER]
    : ['https://accounts.google.com', 'accounts.google.com'];

  return {
    id: 'google',
    configured: Boolean(config.OAUTH_GOOGLE_CLIENT_ID && config.OAUTH_GOOGLE_CLIENT_SECRET),
    authorizeUrl: ({ state, challenge, nonce, redirectUri }) =>
      `${authUrl}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })}`,
    async exchange({ code, verifier, nonce, redirectUri }) {
      const { id_token } = GoogleToken.parse(
        await postForm(tokenUrl, {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: clientId,
          client_secret: config.OAUTH_GOOGLE_CLIENT_SECRET ?? '',
          redirect_uri: redirectUri,
        }),
      );
      const { payload } = await jwtVerify(id_token, jwks, {
        issuer,
        audience: clientId,
        algorithms: ['RS256', 'ES256'],
      });
      const claims = GoogleIdToken.parse(payload);
      if (claims.nonce !== nonce) throw new Error('nonce mismatch');
      return {
        provider: 'google',
        providerUserId: claims.sub,
        email: claims.email.toLowerCase(),
        name: claims.name ?? null,
        avatarUrl: claims.picture ?? null,
      };
    },
  };
}

const GithubToken = z.object({ access_token: z.string() });
const GithubUser = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
});
const GithubEmails = z.array(
  z.object({ email: z.string().email(), primary: z.boolean(), verified: z.boolean() }),
);

/** GitHub OAuth app with PKCE; the identity is the numeric user id, the email the primary verified one. */
export function github(config: Config): OAuthProvider {
  const clientId = config.OAUTH_GITHUB_CLIENT_ID ?? '';
  const authUrl = config.OAUTH_GITHUB_AUTH_URL ?? 'https://github.com/login/oauth/authorize';
  const tokenUrl = config.OAUTH_GITHUB_TOKEN_URL ?? 'https://github.com/login/oauth/access_token';
  const api = config.OAUTH_GITHUB_API_URL ?? 'https://api.github.com';

  const get = async (path: string, token: string) => {
    const res = await fetch(`${api}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'codearena',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`github ${path} ${res.status}`);
    return res.json();
  };

  return {
    id: 'github',
    configured: Boolean(config.OAUTH_GITHUB_CLIENT_ID && config.OAUTH_GITHUB_CLIENT_SECRET),
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      `${authUrl}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        allow_signup: 'true',
      })}`,
    async exchange({ code, verifier, redirectUri }) {
      const { access_token } = GithubToken.parse(
        await postForm(tokenUrl, {
          code,
          code_verifier: verifier,
          client_id: clientId,
          client_secret: config.OAUTH_GITHUB_CLIENT_SECRET ?? '',
          redirect_uri: redirectUri,
        }),
      );
      const user = GithubUser.parse(await get('/user', access_token));
      const primary = GithubEmails.parse(await get('/user/emails', access_token)).find(
        (e) => e.primary && e.verified,
      );
      if (!primary) throw new Error('no primary verified email');
      return {
        provider: 'github',
        providerUserId: String(user.id),
        email: primary.email.toLowerCase(),
        name: user.name ?? user.login,
        avatarUrl: user.avatar_url ?? null,
      };
    },
  };
}

export const OAUTH_PROVIDERS = Symbol('OAUTH_PROVIDERS');
export type OAuthProviders = Record<ProviderId, OAuthProvider>;
