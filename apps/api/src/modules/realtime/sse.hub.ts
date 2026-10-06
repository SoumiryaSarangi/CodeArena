import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { SubmissionQueueData, SubmissionVerdictData } from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { submissions } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { QueuePositionService } from '../submissions/queue-position.service';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';
import { cmpStreamId, type Envelope, type RealtimeMessage } from './events';
import { whenReady } from '../../redis/ready';

const tracer = trace.getTracer('api');
const meter = metrics.getMeter('api');
const connectionsGauge = meter.createUpDownCounter('ca_sse_connections', {
  description: 'Open SSE connections on this instance',
});
const eventsSent = meter.createCounter('ca_sse_events_total', {
  description: 'SSE events sent, by type',
});
const dropped = meter.createCounter('ca_sse_dropped_total', {
  description: 'SSE connections closed by the server, by reason',
});
const resumes = meter.createCounter('ca_sse_resume_total', {
  description: 'Connection set-ups, by how the client caught up (fresh, replayed, snapshot)',
});
const verdictLatency = meter.createHistogram('ca_verdict_to_sse_seconds', {
  description: 'Verdict persisted to written on an SSE connection (NFR-PERF-04)',
  unit: 's',
});

/** SD-§10: a client that falls this far behind is cut off and resumes by replay. */
export const MAX_WRITE_BUFFER = 256 * 1024;
export const MAX_TOPICS = 20;
export const MAX_CONNECTIONS_PER_USER = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Connection {
  readonly id = randomUUID();
  /** Last event id written per topic: anything not newer is a duplicate. */
  readonly sent = new Map<string, string>();
  /** Live events that arrive while the replay is still being written. */
  buffer: RealtimeMessage[] = [];
  replaying = true;
  closed = false;
  registered = false;
  timer: NodeJS.Timeout | undefined;
  constructor(
    readonly userId: string | null,
    readonly topics: string[],
    readonly res: ServerResponse,
    readonly lastEventId: string | null,
  ) {}
}

const frame = (type: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Delivers events to SSE connections (SD-§10). One Redis subscriber per API instance, subscribed
 * to `rt:{topic}` only while a local client wants it. Publishing is decoupled from delivery.
 */
@Injectable()
export class SseHub implements OnModuleDestroy {
  private subscriber: Redis | null = null;
  private readonly byTopic = new Map<string, Set<Connection>>();
  private readonly byUser = new Map<string, Connection[]>();
  private readonly lastQueue = new Map<string, string>();
  private ticker: NodeJS.Timeout | undefined;
  private count = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(QueuePositionService) private readonly positions: QueuePositionService,
  ) {}

  get connections() {
    return this.count;
  }

  private channel(topic: string) {
    return `${this.prefix}rt:${topic}`;
  }

  private sub(): Redis {
    if (!this.subscriber) {
      const s = new Redis(this.config.REDIS_URL);
      s.on('error', () => {});
      s.on('message', (channel: string, raw: string) => this.onMessage(channel, raw));
      this.subscriber = s;
    }
    return this.subscriber;
  }

  /**
   * Registers a connection and brings it up to date. Order matters: subscribe to the live channel
   * first, then read the replay buffer, so an event published in between is either in the replay
   * or in the live buffer (and the per-topic id filter drops the double).
   */
  async attach(conn: Connection): Promise<void> {
    await tracer.startActiveSpan('sse.attach', async (span) => {
      try {
        this.register(conn);
        for (const topic of conn.topics) {
          const set = this.byTopic.get(topic)!;
          if (set.size === 1) await this.sub().subscribe(this.channel(topic));
        }
        let how = 'fresh';
        for (const topic of conn.topics) how = (await this.catchUp(conn, topic)) ?? how;
        resumes.add(1, { result: how });
        span.setAttribute('resume', how);
        conn.replaying = false;
        for (const m of conn.buffer) this.deliver(conn, m);
        conn.buffer = [];
      } finally {
        span.end();
      }
    });
  }

  private register(conn: Connection) {
    conn.registered = true;
    this.count++;
    connectionsGauge.add(1);
    for (const topic of conn.topics) {
      if (!this.byTopic.has(topic)) this.byTopic.set(topic, new Set());
      this.byTopic.get(topic)!.add(conn);
    }
    if (conn.userId) {
      const list = this.byUser.get(conn.userId) ?? [];
      list.push(conn);
      this.byUser.set(conn.userId, list);
      // `detach` replaces the list, so look it up again on every pass.
      while ((this.byUser.get(conn.userId)?.length ?? 0) > MAX_CONNECTIONS_PER_USER) {
        this.close(this.byUser.get(conn.userId)![0]!, 'user-limit');
      }
    }
    this.ticker ??= setInterval(() => void this.tickQueue(), this.config.SSE_QUEUE_TICK_MS);
  }

  /** Writes what the client missed. Returns how it caught up, or null for nothing to say. */
  private async catchUp(conn: Connection, topic: string): Promise<string | null> {
    await whenReady(this.redis);
    const key = `${this.prefix}evt:${topic}`;
    const last = conn.lastEventId;
    const isSub = topic.startsWith('sub:');
    if (!last && !isSub) return null;
    const first = (await this.redis.xrange(key, '-', '+', 'COUNT', 1))[0]?.[0];
    let how: string | null = null;
    // Nothing buffered for a client that is behind, or the buffer starts after what it saw: events
    // may be lost, so tell it where things stand.
    if ((last && (!first || cmpStreamId(last, first) < 0)) || (!last && !first)) {
      if (await this.snapshot(conn, topic)) how = 'snapshot';
    }
    const entries = await this.redis.xrange(key, last ? `(${last}` : '-', '+');
    for (const [id, fields] of entries) {
      this.deliver(conn, { id, envelope: JSON.parse(fields[1]!) as Envelope });
    }
    if (entries.length > 0 && how === null) how = last ? 'replayed' : 'caught-up';
    return how;
  }

  /** The current state of a submission, for a client whose replay buffer is gone. */
  private async snapshot(conn: Connection, topic: string): Promise<boolean> {
    const m = /^sub:(.+)$/.exec(topic);
    if (!m || !UUID.test(m[1]!)) return false;
    const [row] = await this.db
      .select({
        id: submissions.id,
        status: submissions.status,
        verdict: submissions.verdict,
        timeMs: submissions.timeMs,
        memKb: submissions.memKb,
        failedTest: submissions.failedTest,
        runVersion: submissions.currentRunVersion,
      })
      .from(submissions)
      .where(eq(submissions.id, m[1]!))
      .limit(1);
    if (!row || (row.status !== 'done' && row.status !== 'failed') || !row.verdict) return false;
    const data: SubmissionVerdictData = {
      submissionId: row.id,
      runVersion: row.runVersion,
      status: row.status,
      verdict: row.verdict,
      timeMs: row.timeMs ?? 0,
      memKb: row.memKb ?? 0,
      failedTest: row.failedTest,
    };
    // No `id:`: a snapshot must not move the client's Last-Event-ID.
    this.write(
      conn,
      frame('submission.verdict', { topic, type: 'submission.verdict', ts: Date.now(), data }),
    );
    eventsSent.add(1, { type: 'submission.verdict' });
    return true;
  }

  private onMessage(channel: string, raw: string) {
    const topic = channel.slice(`${this.prefix}rt:`.length);
    const conns = this.byTopic.get(topic);
    if (!conns) return;
    let m: RealtimeMessage;
    try {
      m = JSON.parse(raw) as RealtimeMessage;
    } catch {
      return;
    }
    for (const conn of conns) {
      if (conn.replaying) conn.buffer.push(m);
      else this.deliver(conn, m);
    }
  }

  private deliver(conn: Connection, m: RealtimeMessage) {
    const seen = conn.sent.get(m.envelope.topic);
    if (seen && cmpStreamId(m.id, seen) <= 0) return;
    conn.sent.set(m.envelope.topic, m.id);
    this.write(conn, frame(m.envelope.type, m.envelope, m.id));
    eventsSent.add(1, { type: m.envelope.type });
    if (m.envelope.type === 'submission.verdict') {
      verdictLatency.record(Math.max(0, Date.now() - m.envelope.ts) / 1000);
    }
  }

  /** Writes raw text; a connection whose buffer outgrows the cap is closed (it will resume). */
  write(conn: Connection, text: string) {
    if (conn.closed) return;
    conn.res.write(text);
    if (conn.res.writableLength > MAX_WRITE_BUFFER) this.close(conn, 'slow');
  }

  /** Called from the heartbeat timer. */
  ping(conn: Connection) {
    this.write(conn, ': ping\n\n');
  }

  close(conn: Connection, reason: string) {
    if (conn.closed) return;
    dropped.add(1, { reason });
    conn.res.end();
    this.detach(conn);
  }

  /** Frees everything a connection held. Safe to call more than once. */
  detach(conn: Connection) {
    if (conn.closed) return;
    conn.closed = true;
    clearInterval(conn.timer);
    if (!conn.registered) return;
    this.count--;
    connectionsGauge.add(-1);
    if (conn.userId) {
      const list = (this.byUser.get(conn.userId) ?? []).filter((c) => c !== conn);
      if (list.length === 0) this.byUser.delete(conn.userId);
      else this.byUser.set(conn.userId, list);
    }
    for (const topic of conn.topics) {
      const set = this.byTopic.get(topic);
      set?.delete(conn);
      if (set?.size === 0) {
        this.byTopic.delete(topic);
        this.lastQueue.delete(topic);
        this.subscriber?.unsubscribe(this.channel(topic)).catch(() => {});
      }
    }
    if (this.count === 0) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /**
   * FR-QUEUE-08: while a watched submission waits, say where it stands. Live only (no `id:`, not
   * replayed); sent when the numbers change, and once more when a judge takes the job.
   */
  private async tickQueue() {
    for (const [topic, conns] of [...this.byTopic]) {
      const m = /^sub:(.+)$/.exec(topic);
      if (!m || !UUID.test(m[1]!)) continue;
      try {
        const pos = await this.positions.peek(m[1]!);
        if (!pos) continue;
        const data: SubmissionQueueData = { submissionId: m[1]!, ...pos };
        const key = JSON.stringify(data);
        if (this.lastQueue.get(topic) === key) continue;
        this.lastQueue.set(topic, key);
        const text = frame('submission.queue', {
          topic,
          type: 'submission.queue',
          ts: Date.now(),
          data,
        });
        for (const conn of conns) if (!conn.replaying) this.write(conn, text);
        eventsSent.add(conns.size, { type: 'submission.queue' });
      } catch (err) {
        this.log.debug({ err: { message: (err as Error).message } }, 'queue tick failed');
      }
    }
  }

  /**
   * Runs before the HTTP server is closed: an open event stream never ends by itself, so without
   * this a graceful shutdown would wait on every connected client.
   */
  onModuleDestroy() {
    for (const set of [...this.byTopic.values()])
      for (const c of [...set]) this.close(c, 'shutdown');
    clearInterval(this.ticker);
    this.subscriber?.disconnect();
  }
}
