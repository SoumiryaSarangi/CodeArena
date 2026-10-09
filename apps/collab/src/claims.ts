import type { Redis } from 'ioredis';
import type { ClaimBackend } from './identity';

const REFRESH = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Awareness-id claims shared between collab instances through Redis. A claim is `SET … NX PX`, so it expires if its instance dies. */
export class RedisClaims implements ClaimBackend {
  constructor(
    private readonly redis: Redis,
    private readonly instance: string,
    private readonly prefix = 'hocuspocus',
    readonly ttlMs = 120_000,
  ) {}

  private key(documentName: string, clientId: number) {
    return `${this.prefix}:own:${documentName}:${clientId}`;
  }

  private value(socketId: string) {
    return `${this.instance}:${socketId}`;
  }

  async claim(documentName: string, clientId: number, socketId: string): Promise<boolean> {
    const key = this.key(documentName, clientId);
    const value = this.value(socketId);
    if ((await this.redis.set(key, value, 'PX', this.ttlMs, 'NX')) === 'OK') return true;
    return (await this.redis.get(key)) === value;
  }

  async release(documentName: string, clientId: number, socketId: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, this.key(documentName, clientId), this.value(socketId));
  }

  async refresh(
    claims: { documentName: string; clientId: number; socketId: string }[],
  ): Promise<void> {
    await Promise.all(
      claims.map((c) =>
        this.redis.eval(
          REFRESH,
          1,
          this.key(c.documentName, c.clientId),
          this.value(c.socketId),
          String(this.ttlMs),
        ),
      ),
    );
  }
}
