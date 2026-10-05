import { Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AccessToken } from '@codearena/contracts';
import type { Request, Response } from 'express';
import { ProblemError } from '../../common/problem';
import { readCookie, REFRESH_COOKIE, refreshCookie } from './cookies';
import { Public } from './guards';
import { ACCESS_TOKENS, type AccessTokens } from './keys';
import { authEvents, RefreshRaceError, TokensService } from './tokens.service';

const clearRefresh = (res: Response) =>
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookie(), maxAge: undefined });

/**
 * Cookie-authenticated session endpoints. Clients must not send Authorization here: the access
 * token may already be expired, and an invalid bearer is always rejected.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(TokensService) private readonly tokens: TokensService,
    @Inject(ACCESS_TOKENS) private readonly access: AccessTokens,
  ) {}

  /** FR-AUTH-05: rotate the refresh token, return a fresh 15-minute access token. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessToken> {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (!raw) throw new ProblemError('unauthorized', 'Not signed in');
    try {
      const r = await this.tokens.rotate(raw, req.header('user-agent'));
      res.cookie(REFRESH_COOKIE, r.token, refreshCookie());
      const { token, expiresAt } = await this.access.sign({
        sub: r.userId,
        role: r.role,
        sid: r.familyId,
      });
      return { accessToken: token, expiresAt };
    } catch (e) {
      // A concurrent-tab race keeps the cookie: the browser already holds the newer token.
      if (!(e instanceof RefreshRaceError)) clearRefresh(res);
      throw e;
    }
  }

  /** FR-AUTH-08: this device. Idempotent; works with an expired access token. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (raw) await this.tokens.revokeByToken(raw);
    else if (req.user) await this.tokens.revokeFamily(req.user.sid);
    clearRefresh(res);
    authEvents.add(1, { event: 'logout' });
  }

  /** FR-AUTH-08: every device. */
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.tokens.revokeAll(req.user!.id);
    clearRefresh(res);
    authEvents.add(1, { event: 'logout_all' });
  }
}
