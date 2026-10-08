import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { LOGGER } from '../telemetry/logger';
import { reportError } from '../telemetry/sentry';
import { ProblemError } from './problem';

export const zodIssues = (e: ZodError) =>
  e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

const isBodyParserError = (e: unknown): e is { type: string } =>
  typeof e === 'object' &&
  e !== null &&
  typeof (e as { type?: unknown }).type === 'string' &&
  (e as { type: string }).type.startsWith('entity.');

/** Every error leaves the API as application/problem+json (RFC 7807). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    let problem: ProblemError;
    if (exception instanceof ProblemError) {
      problem = exception;
    } else if (exception instanceof ZodError) {
      problem = new ProblemError('validation', 'Request failed validation', {
        errors: zodIssues(exception),
      });
    } else if (exception instanceof HttpException) {
      const s = exception.getStatus();
      problem =
        s === 404
          ? new ProblemError('not-found')
          : s === 413
            ? new ProblemError('payload-too-large')
            : s === 401
              ? new ProblemError('unauthorized')
              : s === 403
                ? new ProblemError('forbidden')
                : s === 429
                  ? new ProblemError('rate-limited')
                  : s < 500
                    ? new ProblemError('validation', exception.message)
                    : new ProblemError('internal');
    } else if (isBodyParserError(exception)) {
      problem =
        exception.type === 'entity.too.large'
          ? new ProblemError('payload-too-large')
          : new ProblemError('validation', 'Malformed request body');
    } else {
      // Unexpected: log the cause, never leak it. `instance` is the request ID (SRS §3.1.8).
      this.log.error({ err: exception, requestId: req.id }, 'unhandled error');
      reportError(exception, req.id);
      problem = new ProblemError('internal');
    }

    const body =
      problem.code === 'internal' ? { ...problem.toBody(req.id) } : problem.toBody(req.id);
    for (const [k, v] of Object.entries(problem.extra.headers ?? {})) res.setHeader(k, v);
    res.status(problem.status).type('application/problem+json').send(body);
  }
}
