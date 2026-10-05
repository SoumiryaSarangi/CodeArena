import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { CONFIG, type Config } from '../../config/config';
import { LOGGER } from '../../telemetry/logger';
import { UsersService } from '../users/users.service';
import { OAUTH_COOKIE, oauthCookie, readCookie, REFRESH_COOKIE, refreshCookie } from './cookies';
import { Public } from './guards';
import { OAUTH_PROVIDERS, type OAuthProviders, type ProviderId } from './oauth/providers';
import { authEvents, TokensService } from './tokens.service';

const b64url = (bytes = 32) => randomBytes(bytes).toString('base64url');

const Flow = z.object({
  p: z.enum(['google', 'github']),
  s: z.string().min(43),
  v: z.string().min(43),
  n: z.string().min(43),
  r: z.string(),
});
type Flow = z.infer<typeof Flow>;

/** Only same-site absolute paths; `//host` and `/\host` would be open redirects. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/home';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/home';
  if (/[\r\n\t]/.test(value)) return '/home';
  return value;
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** FR-AUTH-01: OAuth 2.0 authorization code + PKCE (S256) + state; nonce for OIDC. */
@ApiTags('auth')
@Public()
@Controller('auth')
export class OAuthController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProviders,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TokensService) private readonly tokens: TokensService,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  private redirectUri(p: ProviderId) {
    return `${this.config.PUBLIC_API_URL}/api/auth/callback/${p}`;
  }

  private fail(res: Response, reason: string, err?: unknown) {
    this.log.warn({ reason, err }, 'oauth login failed');
    authEvents.add(1, { event: 'login_failed' });
    res.redirect(302, `${this.config.WEB_URL}/signin?error=oauth-failed`);
  }

  @Get(':provider')
  start(
    @Param('provider') provider: string,
    @Query('returnTo') returnTo: unknown,
    @Res() res: Response,
  ) {
    const p = this.providers[provider as ProviderId];
    if (!p || !p.configured) return this.fail(res, `provider unavailable: ${provider}`);
    const flow: Flow = {
      p: p.id,
      s: b64url(),
      v: b64url(),
      n: b64url(),
      r: safeReturnTo(returnTo),
    };
    const challenge = createHash('sha256').update(flow.v).digest('base64url');
    res.cookie(
      OAUTH_COOKIE,
      Buffer.from(JSON.stringify(flow)).toString('base64url'),
      oauthCookie(),
    );
    res.redirect(
      302,
      p.authorizeUrl({
        state: flow.s,
        challenge,
        nonce: flow.n,
        redirectUri: this.redirectUri(p.id),
      }),
    );
  }

  @Get('callback/:provider')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const raw = readCookie(req, OAUTH_COOKIE);
    res.clearCookie(OAUTH_COOKIE, { ...oauthCookie(), maxAge: undefined });

    let flow: Flow;
    try {
      flow = Flow.parse(JSON.parse(Buffer.from(raw ?? '', 'base64url').toString('utf8')));
    } catch {
      return this.fail(res, 'missing or malformed flow cookie');
    }
    const { code, state, error } = query;
    if (typeof error === 'string') return this.fail(res, `provider returned ${error.slice(0, 64)}`);
    if (flow.p !== provider) return this.fail(res, 'provider mismatch');
    if (typeof state !== 'string' || !equal(state, flow.s)) return this.fail(res, 'state mismatch');
    if (typeof code !== 'string' || code.length === 0 || code.length > 2048)
      return this.fail(res, 'missing code');

    try {
      const profile = await this.providers[flow.p].exchange({
        code,
        verifier: flow.v,
        nonce: flow.n,
        redirectUri: this.redirectUri(flow.p),
      });
      const user = await this.users.upsertFromOAuth(profile);
      const refresh = await this.tokens.issue(user.id, req.header('user-agent'));
      res.cookie(REFRESH_COOKIE, refresh.token, refreshCookie());
      authEvents.add(1, { event: 'login', provider: flow.p });
      res.redirect(302, `${this.config.WEB_URL}${user.handle ? flow.r : '/onboarding'}`);
    } catch (e) {
      return this.fail(res, 'exchange or upsert failed', e);
    }
  }
}
