import { Inject, Injectable } from '@nestjs/common';
import { Lane } from '@codearena/contracts';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { QUEUE_KEY_PREFIX } from './queue.service';

/** Highest priority first (FR-QUEUE-08); `rejudge` is lowest. */
const ORDER: Lane[] = ['contest', 'interactive', 'practice', 'rejudge'];
const GROUP = 'judges';
const CAP = 100;
const DEFAULT_SERVICE_MS = 3000;
const ENTRY_TTL_S = 3600;

export interface Position {
  lane: Lane;
  position: number;
  etaSeconds: number;
  capped: boolean;
}

/**
 * Where a job stands in the queue (SD-§7, decision J-05): derived from the streams, never from
 * anything a judge could write. Position = jobs ahead + 1, 0 once a judge has the job.
 * The ETA here is a first estimate (position x service-time EWMA / live judges); the proper
 * estimator and the live updates come with Q-05.
 */
@Injectable()
export class QueuePositionService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {}

  private entryKey(submissionId: string) {
    return `${this.prefix}sub:entry:${submissionId}`;
  }

  /** Remembered at enqueue so a later request can find the job's place in its lane. */
  async remember(submissionId: string, lane: Lane, entryId: string) {
    await this.redis.set(this.entryKey(submissionId), `${lane}:${entryId}`, 'EX', ENTRY_TTL_S);
  }

  async of(submissionId: string, fallbackLane: Lane): Promise<Position> {
    const raw = await this.redis.get(this.entryKey(submissionId));
    if (!raw) return { lane: fallbackLane, position: 0, etaSeconds: 0, capped: false };
    const [lane, entryId] = [
      raw.slice(0, raw.indexOf(':')) as Lane,
      raw.slice(raw.indexOf(':') + 1),
    ];
    const own = await this.waitingBefore(lane, entryId);
    if (own === null) return { lane, position: 0, etaSeconds: 0, capped: false };
    let ahead = own;
    // Strict priority: everything waiting in a higher lane is served first.
    for (const higher of ORDER.slice(0, ORDER.indexOf(lane))) ahead += await this.lag(higher);
    const capped = ahead >= CAP;
    const position = Math.min(ahead, CAP) + 1;
    return { lane, position, etaSeconds: await this.eta(lane, position), capped };
  }

  /** Jobs in `lane` before `entryId` that no judge has taken; null if this one is already taken. */
  private async waitingBefore(lane: Lane, entryId: string): Promise<number | null> {
    const last = await this.lastDelivered(lane);
    if (last !== null && cmp(entryId, last) <= 0) return null;
    const from = last === null ? '-' : `(${last}`;
    const ids = (await this.redis.xrange(
      `${this.prefix}jobs:${lane}`,
      from,
      `(${entryId}`,
      'COUNT',
      CAP,
    )) as unknown[];
    return ids.length;
  }

  private async groupInfo(lane: Lane): Promise<Record<string, unknown> | null> {
    try {
      const groups = (await this.redis.xinfo(
        'GROUPS',
        `${this.prefix}jobs:${lane}`,
      )) as unknown[][];
      for (const g of groups) {
        const m: Record<string, unknown> = {};
        for (let i = 0; i < g.length; i += 2) m[String(g[i])] = g[i + 1];
        if (m.name === GROUP) return m;
      }
    } catch {
      // no stream yet
    }
    return null;
  }

  private async lastDelivered(lane: Lane): Promise<string | null> {
    const g = await this.groupInfo(lane);
    const id = g?.['last-delivered-id'];
    return typeof id === 'string' && id !== '0-0' ? id : null;
  }

  /** Entries nobody has read yet. Streams without a group (no judge ever started) count their length. */
  private async lag(lane: Lane): Promise<number> {
    const g = await this.groupInfo(lane);
    if (g && typeof g.lag === 'number') return g.lag;
    try {
      return await this.redis.xlen(`${this.prefix}jobs:${lane}`);
    } catch {
      return 0;
    }
  }

  private async eta(lane: Lane, position: number): Promise<number> {
    const [ewma, workers] = await Promise.all([
      this.redis.get(`${this.prefix}ewma:svc:${lane}`),
      this.liveJudges(),
    ]);
    const svc = ewma && Number(ewma) > 0 ? Number(ewma) : DEFAULT_SERVICE_MS;
    return Math.ceil((position * svc) / Math.max(1, workers) / 1000);
  }

  private async liveJudges(): Promise<number> {
    let n = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.prefix}hb:*`,
        'COUNT',
        100,
      );
      cursor = next;
      n += keys.length;
    } while (cursor !== '0');
    return n;
  }
}

/** Compares two stream ids (`ms-seq`). */
function cmp(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}
