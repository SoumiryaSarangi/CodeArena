import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

const tracer = trace.getTracer('api');
const requestSeconds = metrics
  .getMeter('api')
  .createHistogram('ca_http_request_seconds', { unit: 's', description: 'HTTP request duration' });

/** One span (`http <route>`) and one `ca_http_request_seconds` sample per request (SD-§15). */
export function httpTelemetry(log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const span = tracer.startSpan(`http ${req.method} ${req.path}`, {
      attributes: { 'http.method': req.method, 'request.id': req.id },
    });
    const reqLog = log.child({ requestId: req.id, traceId: span.spanContext().traceId });
    res.on('finish', () => {
      // Use the matched route pattern (not the raw path) so metric cardinality stays bounded.
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      requestSeconds.record(seconds, { route, status: String(res.statusCode) });
      span.setAttribute('http.route', route);
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      reqLog.info(
        { method: req.method, route, status: res.statusCode, ms: Math.round(seconds * 1000) },
        'request',
      );
    });
    // The span is the active one while the request is handled, so every span started on the way
    // (queue.enqueue, board.update, ...) is its child: one request, one trace (SD-§15.1).
    context.with(trace.setSpan(context.active(), span), next);
  };
}
