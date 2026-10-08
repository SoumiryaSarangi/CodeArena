import * as Sentry from '@sentry/node';
import { trace } from '@opentelemetry/api';

/**
 * Error tracking (O-01). Inert without a DSN. Tracing stays with OpenTelemetry (the SDK registers no tracer provider of its own),
 * and nothing about the user's request leaves the process: no bodies, cookies, headers or IPs, so no
 * source code or e-mail can end up in Sentry (NFR-OBS-03).
 */
export function startSentry(dsn: string | undefined, environment: string) {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      return event;
    },
  });
}

/** Reports an unexpected (5xx) error with the ids needed to find its log line and its trace. */
export function reportError(err: unknown, requestId: string | undefined) {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  Sentry.captureException(err, {
    tags: { ...(requestId ? { requestId } : {}), ...(traceId ? { traceId } : {}) },
  });
}
