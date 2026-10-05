import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@codearena/contracts';
import type { NextFunction, Request, Response } from 'express';
import { ProblemError } from '../../common/problem';
import { UsersService } from '../users/users.service';
import { CSRF_COOKIE, csrfCookie, readCookie } from './cookies';
import { ACCESS_TOKENS, type AccessTokens } from './keys';

export interface AuthUser {
  id: string;
  role: Role;
  /** Refresh-token family of this session. */
  sid: string;
}

declare global {
  // Express's documented extension point for adding request properties.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const PUBLIC = 'auth:public';
const ROLES = 'auth:roles';
const SKIP_CSRF = 'auth:skip-csrf';
const REQUIRE_HANDLE = 'auth:require-handle';

/** Reachable without a bearer token (a bearer that *is* sent must still be valid). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Minimum role; admin ⊇ setter ⊇ user (FR-AUTH-09). */
export const Roles = (min: Role) => SetMetadata(ROLES, min);
/** Only for service-to-service routes authenticated another way (e.g. /internal with a token). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
/** Scored actions need a chosen handle (FR-AUTH-02). */
export const RequireHandle = () => SetMetadata(REQUIRE_HANDLE, true);

const RANK: Record<Role, number> = { user: 0, setter: 1, admin: 2 };

const meta = <T>(reflector: Reflector, key: string, ctx: ExecutionContext) =>
  reflector.getAllAndOverride<T | undefined>(key, [ctx.getHandler(), ctx.getClass()]);

/** Default-deny: every route needs a valid bearer token unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ACCESS_TOKENS) private readonly tokens: AccessTokens,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
      if (!match) throw new ProblemError('unauthorized', 'Malformed Authorization header');
      const claims = await this.tokens.verify(match[1]!);
      req.user = { id: claims.sub, role: claims.role, sid: claims.sid };
      return true;
    }
    if (meta<boolean>(this.reflector, PUBLIC, ctx)) return true;
    throw new ProblemError('unauthorized', 'Sign in to continue');
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** FR-AUTH-07: double-submit. Mutations must echo the ca_csrf cookie in X-CSRF-Token. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!MUTATING.has(req.method) || meta<boolean>(this.reflector, SKIP_CSRF, ctx)) return true;
    const cookie = readCookie(req, CSRF_COOKIE);
    const header = req.header('x-csrf-token');
    if (cookie && header && sameToken(cookie, header)) return true;
    throw new ProblemError(
      'forbidden',
      'Missing or invalid CSRF token. Reload the page and try again.',
    );
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const min = meta<Role>(this.reflector, ROLES, ctx);
    if (!min) return true;
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new ProblemError('unauthorized', 'Sign in to continue');
    if (RANK[user.role] < RANK[min]) throw new ProblemError('forbidden');
    return true;
  }
}

@Injectable()
export class RequireHandleGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!meta<boolean>(this.reflector, REQUIRE_HANDLE, ctx)) return true;
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new ProblemError('unauthorized', 'Sign in to continue');
    if (await this.users.hasHandle(user.id)) return true;
    throw new ProblemError('forbidden', 'Choose a handle before doing this.');
  }
}

const CSRF_RE = /^[A-Za-z0-9_-]{43}$/;

/** Gives every client (guests too) a CSRF cookie to echo back. */
export function csrfCookieMiddleware(req: Request, res: Response, next: NextFunction) {
  const existing = readCookie(req, CSRF_COOKIE);
  if (!existing || !CSRF_RE.test(existing)) {
    res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), csrfCookie());
  }
  next();
}
