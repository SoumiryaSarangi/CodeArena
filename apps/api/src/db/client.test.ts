import { describe, expect, it, vi } from 'vitest';
import { connect } from './client';

describe('F-04: the database pool', () => {
  it('F-04: an idle connection that dies is reported to the handler and does not crash the process', async () => {
    const heard = vi.fn();
    // nothing listens on this port: no connection is opened, only the pool's event handling is exercised
    const { pool } = connect('postgres://u:p@127.0.0.1:1/none', heard);
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    const dead = new Error('terminating connection due to administrator command');
    expect(() => pool.emit('error', dead)).not.toThrow();
    expect(heard).toHaveBeenCalledWith(dead);
    await pool.end();
  });

  it('F-04: without a handler the default still listens (an unlistened pool error is an uncaught exception)', async () => {
    const { pool } = connect('postgres://u:p@127.0.0.1:1/none');
    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    await pool.end();
  });
});
