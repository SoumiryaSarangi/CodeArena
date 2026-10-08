import type { SseEventType } from '@codearena/contracts';
import { trace } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

const tracer = trace.getTracer('api');

/** SD-§7: replay buffer of `evt:{topic}`. */
export const EVT_MAXLEN = 2000;
export const EVT_IDLE_TTL_S = 300;

export interface Envelope<T = unknown> {
  topic: string;
  type: SseEventType;
  ts: number;
  data: T;
}

/** What goes on the `rt:{topic}` channel: the replay stream id (the SSE `id:`) plus the envelope. */
export interface RealtimeMessage<T = unknown> {
  id: string;
  envelope: Envelope<T>;
}

/**
 * Tells everyone watching a topic (SD-§10): append to the replay buffer, then fan out on
 * `rt:{topic}`. Returns the stream id, or null if Redis is down (the event is then lost; the state
 * itself lives in Postgres and a reconnecting client reads it).
 */
export async function publishEvent<T>(
  redis: Redis,
  prefix: string,
  log: Logger,
  topic: string,
  type: SseEventType,
  data: T,
): Promise<string | null> {
  return tracer.startActiveSpan('sse.publish', async (span) => {
    span.setAttributes({ 'sse.type': type });
    try {
      return await publish(redis, prefix, log, topic, type, data);
    } finally {
      span.end();
    }
  });
}

async function publish<T>(
  redis: Redis,
  prefix: string,
  log: Logger,
  topic: string,
  type: SseEventType,
  data: T,
): Promise<string | null> {
  const envelope: Envelope<T> = { topic, type, ts: Date.now(), data };
  const evtKey = `${prefix}evt:${topic}`;
  try {
    const id = (await redis.xadd(
      evtKey,
      'MAXLEN',
      '~',
      EVT_MAXLEN,
      '*',
      'event',
      JSON.stringify(envelope),
    )) as string;
    await redis.expire(evtKey, EVT_IDLE_TTL_S);
    const message: RealtimeMessage<T> = { id, envelope };
    await redis.publish(`${prefix}rt:${topic}`, JSON.stringify(message));
    return id;
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, topic }, 'could not publish the event');
    return null;
  }
}

/** Compares two stream ids (`ms-seq`): negative, 0 or positive. */
export function cmpStreamId(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}
