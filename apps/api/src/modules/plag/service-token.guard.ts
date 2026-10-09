import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';

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
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(expected);
    if (!given || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ProblemError('unauthorized', 'Missing or invalid service token');
    }
    return true;
  }
}
