import * as Sentry from '@sentry/nextjs';

/**
 * Browser error tracking (O-01). Inert without a DSN. Errors only: no tracing, no replay, no user or
 * request data, so nothing a contestant typed (source code) can leave the browser (NFR-OBS-03).
 */
export function startSentry(dsn: string | undefined, environment: string) {
  if (!dsn) return false;
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
  return true;
}
