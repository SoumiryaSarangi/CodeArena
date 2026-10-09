import type { Connection } from '@hocuspocus/server';

/** The close code sent when a session has ended (4xxx is the application range). */
export const CLOSE_SESSION_ENDED = { code: 4401, reason: 'session-ended' } as const;

/**
 * FR-PAD-05: every authenticated connection with the moment its session ends. `beforeHandleMessage` checks it on each
 * message; `sweep` closes the ones that only sit idle (awareness pings are not guaranteed), so a session cannot outlive
 * its end by staying quiet.
 */
export class Sessions {
  private readonly live = new Map<string, { connection: Connection; expiresAt: number }>();

  add(socketId: string, connection: Connection, expiresAt: number): void {
    this.live.set(socketId, { connection, expiresAt });
  }

  remove(socketId: string): boolean {
    return this.live.delete(socketId);
  }

  get size(): number {
    return this.live.size;
  }

  /** Closes every connection whose session has ended at `now`; returns how many. */
  sweep(now: number): number {
    let closed = 0;
    for (const [id, s] of [...this.live]) {
      if (now > s.expiresAt) {
        this.live.delete(id);
        s.connection.close(CLOSE_SESSION_ENDED);
        closed++;
      }
    }
    return closed;
  }
}
