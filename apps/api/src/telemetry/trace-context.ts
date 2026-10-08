import { context, trace, TraceFlags, type Context } from '@opentelemetry/api';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** W3C traceparent of the active span, or undefined when there is none (or it is not sampled-in). */
export function activeTraceparent(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || !trace.isSpanContextValid(sc)) return undefined;
  return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, '0')}`;
}

/**
 * A context whose parent is the span a `traceparent` names, so spans started in it join that trace.
 * Does not depend on a registered propagator. Anything that is not a valid traceparent gives the
 * current context unchanged.
 */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  const m = traceparent ? TRACEPARENT.exec(traceparent) : null;
  if (!m) return context.active();
  return trace.setSpanContext(context.active(), {
    traceId: m[1]!,
    spanId: m[2]!,
    traceFlags: parseInt(m[3]!, 16) as TraceFlags,
    isRemote: true,
  });
}

/** `trace:{submissionId}:{runVersion}`: lets the result path rejoin the submission's trace. */
export const traceKey = (prefix: string, submissionId: string, runVersion: number) =>
  `${prefix}trace:${submissionId}:${runVersion}`;
export const TRACE_KEY_TTL_S = 3600;
