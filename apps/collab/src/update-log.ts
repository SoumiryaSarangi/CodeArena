import { metrics } from '@opentelemetry/api';
import pg from 'pg';
import * as Y from 'yjs';

const meter = metrics.getMeter('collab');
const logged = meter.createCounter('ca_collab_log_updates_total', {
  description: 'Document updates written to the room log',
});
const checkpoints = meter.createCounter('ca_collab_log_checkpoints_total', {
  description: 'Checkpoints written',
});
const failures = meter.createCounter('ca_collab_log_errors_total', {
  description: 'Log writes that failed, by stage',
});
const healed = meter.createCounter('ca_collab_log_healed_total', {
  description: 'Catch-up updates added because the log was behind the document',
});

/** A checkpoint of the document is written every this many logged updates (SD-§11.4, FR-PAD-10). */
export const CHECKPOINT_EVERY = 200;

export interface LoggedUpdate {
  update: Uint8Array;
  /** When the server received it. */
  ts: Date;
  /** The verified author; null for the server itself and for a catch-up. */
  userId: string | null;
}

export type EventKind = 'join' | 'leave' | 'language';

/**
 * The room's history (SD-§11.2, §11.4, CP-06): every update to the document, in order, with checkpoints, plus the events
 * that belong on a replay's scrubber. Used off the editing path: nothing here may delay or break an edit.
 */
export interface UpdateLog {
  /** Queues an update; it is written within a few hundred milliseconds. */
  record(roomId: string, update: LoggedUpdate): void;
  /** Writes whatever is queued for a room (or for all rooms) and waits. */
  flush(roomId?: string): Promise<void>;
  event(roomId: string, kind: EventKind, userId: string | null, payload?: object): Promise<void>;
  /**
   * Makes the log equal to the document: anything the document has that the log does not (a tail lost to a crash, a
   * batch that never reached the database) is appended as one catch-up update. Returns whether it had to.
   */
  reconcile(roomId: string, finalState: Uint8Array): Promise<'same' | 'healed'>;
}

export interface PgLogOptions {
  flushMs?: number;
  maxBatch?: number;
  checkpointEvery?: number;
  /** Logging problems are reported here and never thrown at the editor. */
  warn?: (msg: string, extra?: object) => void;
}

const newDoc = () => new Y.Doc({ gc: false });

export class PgUpdateLog implements UpdateLog {
  private readonly queues = new Map<string, LoggedUpdate[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly every: number;
  private readonly warn: (msg: string, extra?: object) => void;

  constructor(
    private readonly pool: pg.Pool,
    opts: PgLogOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 200;
    this.maxBatch = opts.maxBatch ?? 100;
    this.every = opts.checkpointEvery ?? CHECKPOINT_EVERY;
    this.warn = opts.warn ?? (() => undefined);
  }

  static connect(connectionString: string, opts?: PgLogOptions) {
    return new PgUpdateLog(new pg.Pool({ connectionString, max: 3 }), opts);
  }

  record(roomId: string, update: LoggedUpdate): void {
    const q = this.queues.get(roomId) ?? [];
    q.push(update);
    this.queues.set(roomId, q);
    if (q.length >= this.maxBatch) {
      void this.flush(roomId);
    } else if (!this.timers.has(roomId)) {
      const t = setTimeout(() => void this.flush(roomId), this.flushMs);
      t.unref();
      this.timers.set(roomId, t);
    }
  }

  async flush(roomId?: string): Promise<void> {
    if (roomId === undefined) {
      await Promise.all(
        [...new Set([...this.queues.keys(), ...this.chains.keys()])].map((r) => this.flush(r)),
      );
      return;
    }
    const t = this.timers.get(roomId);
    if (t) clearTimeout(t);
    this.timers.delete(roomId);
    // one writer per room at a time: a flush waits for the one before it
    const run = (this.chains.get(roomId) ?? Promise.resolve()).then(() => this.writeQueued(roomId));
    this.chains.set(roomId, run);
    try {
      await run;
    } finally {
      if (this.chains.get(roomId) === run) this.chains.delete(roomId);
    }
  }

  private async writeQueued(roomId: string): Promise<void> {
    const items = this.queues.get(roomId);
    if (!items || items.length === 0) return;
    this.queues.delete(roomId);
    try {
      await this.append(roomId, items);
    } catch (err) {
      // keep them, in front of anything queued since, and try again shortly: a log hiccup must not lose history
      this.queues.set(roomId, [...items, ...(this.queues.get(roomId) ?? [])]);
      failures.add(1, { stage: 'append' });
      this.warn('could not write the update log, will retry', {
        roomId,
        err: (err as Error).message,
      });
      if (!this.timers.has(roomId)) {
        const t = setTimeout(() => void this.flush(roomId), 1000);
        t.unref();
        this.timers.set(roomId, t);
      }
    }
  }

  private async lock(client: pg.PoolClient, roomId: string) {
    // the same lock the API takes when it writes a room event, so sequence numbers never collide
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [roomId]);
  }

  private async append(roomId: string, items: LoggedUpdate[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lock(client, roomId);
      const max = (
        await client.query<{ n: string }>(
          'select coalesce(max(seq), 0) as n from room_updates where room_id = $1',
          [roomId],
        )
      ).rows[0]!;
      const first = Number(max.n) + 1;
      const params: unknown[] = [];
      const rows = items.map((it, i) => {
        params.push(roomId, first + i, it.ts, it.userId, Buffer.from(it.update));
        const b = i * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
      });
      await client.query(
        `insert into room_updates (room_id, seq, ts, user_id, update) values ${rows.join(', ')}`,
        params,
      );
      const last = first + items.length - 1;
      for (
        let at = (Math.floor((first - 1) / this.every) + 1) * this.every;
        at <= last;
        at += this.every
      ) {
        await this.checkpoint(client, roomId, at);
      }
      await client.query('commit');
      logged.add(items.length);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The document exactly as it was after update `at`: the last checkpoint before it plus the updates since. */
  private async docAt(client: pg.PoolClient, roomId: string, at: number | null): Promise<Y.Doc> {
    const ck = (
      await client.query<{ seq: string; state: Buffer }>(
        `select seq, state from room_checkpoints where room_id = $1 ${at === null ? '' : 'and seq < $2'} order by seq desc limit 1`,
        at === null ? [roomId] : [roomId, at],
      )
    ).rows[0];
    const doc = newDoc();
    if (ck) Y.applyUpdate(doc, new Uint8Array(ck.state));
    const tail = await client.query<{ update: Buffer }>(
      `select update from room_updates where room_id = $1 and seq > $2 ${at === null ? '' : 'and seq <= $3'} order by seq`,
      at === null ? [roomId, ck ? ck.seq : 0] : [roomId, ck ? ck.seq : 0, at],
    );
    for (const r of tail.rows) Y.applyUpdate(doc, new Uint8Array(r.update));
    return doc;
  }

  private async checkpoint(client: pg.PoolClient, roomId: string, at: number): Promise<void> {
    const doc = await this.docAt(client, roomId, at);
    await client.query(
      'insert into room_checkpoints (room_id, seq, state) values ($1, $2, $3) on conflict do nothing',
      [roomId, at, Buffer.from(Y.encodeStateAsUpdate(doc))],
    );
    checkpoints.add(1);
  }

  async event(
    roomId: string,
    kind: EventKind,
    userId: string | null,
    payload: object = {},
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lock(client, roomId);
      await client.query(
        `insert into room_events (room_id, seq, ts, user_id, kind, payload)
         values ($1, (select coalesce(max(seq), 0) + 1 from room_events where room_id = $1), now(), $2, $3, $4)`,
        [roomId, userId, kind, JSON.stringify(payload)],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      failures.add(1, { stage: 'event' });
      this.warn('could not write a room event', { roomId, kind, err: (err as Error).message });
    } finally {
      client.release();
    }
  }

  async reconcile(roomId: string, finalState: Uint8Array): Promise<'same' | 'healed'> {
    await this.flush(roomId);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lock(client, roomId);
      const replayed = await this.docAt(client, roomId, null);
      const final = newDoc();
      Y.applyUpdate(final, finalState);
      if (Y.equalSnapshots(Y.snapshot(replayed), Y.snapshot(final))) {
        await client.query('commit');
        return 'same';
      }
      const missing = Y.diffUpdate(finalState, Y.encodeStateVector(replayed));
      const max = (
        await client.query<{ n: string }>(
          'select coalesce(max(seq), 0) as n from room_updates where room_id = $1',
          [roomId],
        )
      ).rows[0]!;
      const seq = Number(max.n) + 1;
      await client.query(
        'insert into room_updates (room_id, seq, ts, user_id, update) values ($1, $2, now(), null, $3)',
        [roomId, seq, Buffer.from(missing)],
      );
      if (seq % this.every === 0) await this.checkpoint(client, roomId, seq);
      await client.query('commit');
      healed.add(1);
      this.warn('the update log was behind the document; a catch-up update was added', {
        roomId,
        seq,
      });
      return 'healed';
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      failures.add(1, { stage: 'reconcile' });
      this.warn('could not reconcile the update log', { roomId, err: (err as Error).message });
      return 'same';
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}
