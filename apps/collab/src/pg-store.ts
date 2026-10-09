import pg from 'pg';
import type { DocStore } from './store';

/** Postgres foreign-key violation: the room row is gone. */
const FK_VIOLATION = '23503';

/**
 * `room_docs` (state, bytea) is the source of truth for a room's document (ADR-015). `rooms.doc_bytes` follows it so the
 * size can be read without loading the document.
 */
export class PgDocStore implements DocStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: (msg: string, extra?: object) => void = () => undefined,
  ) {}

  static connect(connectionString: string, log?: PgDocStore['log']) {
    return new PgDocStore(new pg.Pool({ connectionString, max: 4 }), log);
  }

  async fetch(roomId: string): Promise<Uint8Array | null> {
    const r = await this.pool.query<{ state: Buffer }>(
      'select state from room_docs where room_id = $1',
      [roomId],
    );
    const row = r.rows[0];
    return row ? new Uint8Array(row.state) : null;
  }

  async store(roomId: string, state: Uint8Array): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into room_docs (room_id, state, updated_at) values ($1, $2, now())
         on conflict (room_id) do update set state = excluded.state, updated_at = now()`,
        [roomId, Buffer.from(state)],
      );
      await client.query('update rooms set doc_bytes = $2 where id = $1', [
        roomId,
        state.byteLength,
      ]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      if ((err as { code?: string }).code === FK_VIOLATION) {
        this.log('room is gone, document not stored', { roomId });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}
