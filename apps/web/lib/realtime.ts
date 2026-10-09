import type { SseEventType, TicketResponse } from '@codearena/contracts';
import { apiFetch } from './api';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface RealtimeEvent {
  id: string;
  topic: string;
  type: SseEventType;
  ts: number;
  data: Record<string, unknown>;
}

/** The slice of the browser's EventSource that the client uses (so tests can fake it). */
export interface EventSourceLike {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (e: { data: string; lastEventId: string }) => void): void;
  close(): void;
}

export interface RealtimeDeps {
  getTicket: (topics: string[]) => Promise<string>;
  createSource: (url: string) => EventSourceLike;
  /**
   * Where the stream lives. Empty = this origin (dev, via the Next rewrite). In production it is the
   * API host, because Vercel rewrites cannot carry a long-lived stream reliably; the ticket in the
   * URL is the credential, so no cookies are needed cross-origin (CORS is set by Caddy).
   */
  baseUrl?: string;
  /** Back-off steps in ms; the last one repeats. */
  backoffMs?: number[];
  random?: () => number;
  isOnline?: () => boolean;
}

export const TYPES: SseEventType[] = [
  'submission.progress',
  'submission.queue',
  'submission.verdict',
  'board.snapshot',
  'board.diff',
  'board.freeze',
  'board.resolve.step',
  'clar.new',
  'clar.answer',
  'announce.new',
  'contest.state',
  'review.ready',
  'room.run',
  'room.settings',
  'sys.status',
];

/** After this many failed attempts in a row while the browser says it is offline, we say "Offline". */
const OFFLINE_AFTER = 2;

/**
 * One SSE connection for a fixed set of topics (SD-§10, FR-RT-01..03).
 *
 * `EventSource` reconnects by itself, but it would reuse the same URL, and a ticket is single use:
 * the retry would be refused for ever. So on any error the source is closed, a **new ticket** is
 * fetched and a new source opened after a back-off (1 s up to 15 s, with jitter), passing the last
 * event id seen as `lastEventId` so the server replays what was missed (FR-RT-02).
 */
export class RealtimeConnection {
  private source: EventSourceLike | null = null;
  private lastId: string | null = null;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  state: ConnectionState = 'connecting';

  constructor(
    private readonly topics: string[],
    private readonly onEvent: (e: RealtimeEvent) => void,
    private readonly onState: (s: ConnectionState) => void,
    private readonly deps: RealtimeDeps,
  ) {}

  start() {
    void this.open();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.source?.close();
    this.source = null;
  }

  private set(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  private async open() {
    if (this.closed) return;
    let ticket: string;
    try {
      ticket = await this.deps.getTicket(this.topics);
    } catch {
      return this.retry();
    }
    if (this.closed) return;
    const q = new URLSearchParams({ ticket, topics: this.topics.join(',') });
    if (this.lastId) q.set('lastEventId', this.lastId);
    const es = this.deps.createSource(`${this.deps.baseUrl ?? ''}/api/sse?${q}`);
    this.source = es;
    es.onopen = () => {
      this.failures = 0;
      this.set('connected');
    };
    for (const type of TYPES) {
      es.addEventListener(type, (e) => {
        try {
          const env = JSON.parse(e.data) as Omit<RealtimeEvent, 'id'>;
          if (e.lastEventId) this.lastId = e.lastEventId;
          this.onEvent({ ...env, id: e.lastEventId });
        } catch {
          // an event we cannot read is dropped, never fatal
        }
      });
    }
    es.onerror = () => {
      es.close();
      if (this.source === es) this.source = null;
      this.retry();
    };
  }

  private retry() {
    if (this.closed) return;
    this.failures++;
    const online = this.deps.isOnline?.() ?? (typeof navigator === 'undefined' || navigator.onLine);
    this.set(!online && this.failures >= OFFLINE_AFTER ? 'offline' : 'reconnecting');
    const steps = this.deps.backoffMs ?? [1000, 2000, 4000, 8000, 15000];
    const base = steps[Math.min(this.failures - 1, steps.length - 1)]!;
    const jitter = 0.75 + 0.5 * (this.deps.random ?? Math.random)();
    this.timer = setTimeout(() => void this.open(), Math.round(base * jitter));
  }
}

/** The real thing: tickets from the API, the browser's EventSource. */
export function subscribe(
  topics: string[],
  onEvent: (e: RealtimeEvent) => void,
  onState: (s: ConnectionState) => void = () => {},
): () => void {
  const conn = new RealtimeConnection(topics, onEvent, onState, {
    getTicket: async (t) =>
      (await apiFetch<TicketResponse>('POST', '/realtime/ticket', { topics: t })).ticket,
    createSource: (url) => new EventSource(url) as unknown as EventSourceLike,
    // Inlined at build time; set NEXT_PUBLIC_REALTIME_URL=https://api.<host> on Vercel.
    baseUrl: (process.env.NEXT_PUBLIC_REALTIME_URL ?? '').replace(/\/$/, ''),
  });
  conn.start();
  return () => conn.close();
}
