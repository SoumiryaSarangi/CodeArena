import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';

/** Constant-time comparison of a presented service token with the configured one. */
export function matchesToken(expected: string, given: string | undefined): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return !!given && a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Service-to-service routes (the plagiarism job): a shared secret in `X-Service-Token`, compared in constant time.
 * Not a bearer token: the `Authorization` header belongs to user sessions, and the user guard would reject it. The
 * routes using this guard are `@Public()` (no user) and `@SkipCsrf()` (no browser). With no token configured every
 * call is refused, so a missing variable never means "open".
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.PLAG_SERVICE_TOKEN;
    if (!expected || expected === 'not-configured') {
      throw new ProblemError('forbidden', 'The plagiarism service is not configured');
    }
    const given = ctx.switchToHttp().getRequest<Request>().header('x-service-token');
    if (!matchesToken(expected, given)) {
      throw new ProblemError('unauthorized', 'Missing or invalid service token');
    }
    return true;
  }
}

/** The same for the collab server (CP-01): its own secret, so the plag job's token opens nothing here and vice versa. */
@Injectable()
export class CollabTokenGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.COLLAB_SERVICE_TOKEN;
    if (!expected || expected === 'not-configured') {
      throw new ProblemError('forbidden', 'The collab service is not configured');
    }
    const given = ctx.switchToHttp().getRequest<Request>().header('x-service-token');
    if (!matchesToken(expected, given)) {
      throw new ProblemError('unauthorized', 'Missing or invalid service token');
    }
    return true;
  }
}
