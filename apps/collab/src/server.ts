import { timingSafeEqual } from 'node:crypto';
import type { CollabIdentity } from '@codearena/contracts';
import { Database } from '@hocuspocus/extension-database';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Server, type Extension } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import { metrics, trace } from '@opentelemetry/api';
import { authorizeTicket, type ApiLink } from './auth';
import { RedisClaims } from './claims';
import { AwarenessOwners, rewriteAwareness, roomIdOf } from './identity';
import { CLOSE_SESSION_ENDED, Sessions } from './session';
import type { DocStore } from './store';

const tracer = trace.getTracer('collab');
const meter = metrics.getMeter('collab');
const connections = meter.createCounter('ca_collab_connections_total', {
  description: 'Collab connection attempts by outcome',
});
const open = meter.createUpDownCounter('ca_collab_connections_open', {
  description: 'Authenticated collab connections right now',
});
const awareness = meter.createCounter('ca_collab_awareness_total', {
  description: 'Awareness states rewritten with the verified identity, or dropped',
});
const closed = meter.createCounter('ca_collab_sessions_closed_total', {
  description: 'Connections the server closed, by reason',
});

export interface CollabOptions {
  port: number;
  api: ApiLink;
  /** The shared secret for this server's own internal HTTP routes (the same `COLLAB_SERVICE_TOKEN`). */
  token?: string;
  /** Test seam: the clock, in epoch milliseconds. */
  now?: () => number;
  /** How often idle sessions are checked for expiry. */
  sweepMs?: number;
  /** Where documents live between sessions (FR-PAD-06). Without one they exist only while someone is connected. */
  store?: DocStore;
  /** Shares updates, awareness and awareness-id claims with the other collab instances through Redis (FR-PAD-07). */
  redis?: {
    client: Redis;
    /** A name for this instance in Redis; random if omitted. */
    instance?: string;
    /** How long a store lock survives if the instance holding it dies. */
    lockTimeoutMs?: number;
  };
  /** Milliseconds after the last change before the document is stored (default 2000), and the longest it may wait (10000). */
  debounce?: number;
  maxDebounce?: number;
}

/** What `onAuthenticate` puts on the connection: everything the rest of the server may believe about the client. */
export interface CollabContext {
  identity: CollabIdentity;
}

const sameToken = (expected: string, given: string | undefined) => {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return !!given && a.length === b.length && timingSafeEqual(a, b);
};

/**
 * CP-01 (SD-§11, ADR-010): the Hocuspocus server of the interview pad. It trusts nothing a client says about itself:
 * who they are comes from the API (which redeems the single-use ticket), observers are read-only, awareness identities
 * are rewritten from the verified one, and a session ends when the API said it does.
 */
export function createServer(opts: CollabOptions) {
  const now = opts.now ?? Date.now;
  const instance = opts.redis?.instance ?? `collab-${Math.random().toString(36).slice(2, 8)}`;
  const claims = opts.redis ? new RedisClaims(opts.redis.client, instance) : undefined;
  const owners = new AwarenessOwners(claims);
  const sessions = new Sessions();

  // Redis first (its docs: it must run before the Database extension so one instance stores at a time), then Postgres.
  const extensions: Extension[] = [];
  if (opts.redis) {
    extensions.push(
      new RedisExtension({
        redis: opts.redis.client,
        identifier: instance,
        prefix: 'hocuspocus',
        lockTimeout: opts.redis.lockTimeoutMs ?? 1500,
      }),
    );
  }
  const store = opts.store;
  if (store) {
    extensions.push(
      new Database({
        fetch: async ({ documentName }) => {
          const roomId = roomIdOf(documentName);
          return roomId ? store.fetch(roomId) : null;
        },
        store: async ({ documentName, state }) => {
          const roomId = roomIdOf(documentName);
          if (roomId) await store.store(roomId, state);
        },
      }),
    );
  }

  const server = new Server<CollabContext>({
    port: opts.port,
    name: 'collab',
    quiet: true,
    yDocOptions: { gc: false, gcFilter: () => true }, // SD-§11.1: the history stays, snapshots need it
    extensions,
    ...(opts.debounce !== undefined ? { debounce: opts.debounce } : {}),
    ...(opts.maxDebounce !== undefined ? { maxDebounce: opts.maxDebounce } : {}),

    async onAuthenticate(data) {
      return tracer.startActiveSpan('collab.authenticate', async (span) => {
        try {
          const roomId = roomIdOf(data.documentName);
          if (!roomId) {
            connections.add(1, { outcome: 'bad-document' });
            throw new Error('forbidden');
          }
          const r = await authorizeTicket(opts.api, roomId, data.token);
          if (!r.ok) {
            connections.add(1, { outcome: r.reason });
            throw new Error('forbidden');
          }
          data.connectionConfig.readOnly = r.identity.readOnly;
          connections.add(1, { outcome: 'ok', role: r.identity.role });
          span.setAttribute('collab.role', r.identity.role);
          return { identity: r.identity };
        } finally {
          span.end();
        }
      });
    },

    async connected(data) {
      sessions.add(data.socketId, data.connection, data.context.identity.expiresAt);
      open.add(1);
    },

    async beforeHandleMessage(data) {
      if (now() > data.context.identity.expiresAt) {
        sessions.remove(data.socketId);
        closed.add(1, { reason: 'session-ended-message' });
        data.connection.close(CLOSE_SESSION_ENDED);
        throw new Error('session ended');
      }
    },

    async beforeHandleAwareness(data) {
      const identity = data.context?.identity;
      if (!identity) return; // written by the server itself, not by a client
      const r = await rewriteAwareness(
        data.states,
        identity,
        data.documentName,
        data.socketId,
        owners,
      );
      if (r.rewritten) awareness.add(r.rewritten, { result: 'rewritten' });
      if (r.dropped) awareness.add(r.dropped, { result: 'dropped' });
    },

    async onDisconnect(data) {
      await owners.release(data.documentName, data.socketId);
      if (sessions.remove(data.socketId)) open.add(-1);
    },

    // Internal HTTP, for the API: `POST /internal/rooms/{roomId}/close` ends every session in that room (CP-02).
    async onRequest({ request, response }) {
      const m = /^\/internal\/rooms\/([0-9a-f-]{36})\/close$/.exec(
        request.url?.split('?')[0] ?? '',
      );
      if (!m || request.method !== 'POST') return;
      if (
        !opts.token ||
        !sameToken(opts.token, request.headers['x-service-token'] as string | undefined)
      ) {
        response.writeHead(401).end();
        // An empty rejection tells Hocuspocus the request is handled (its documented idiom).
        throw undefined;
      }
      closeRoom(m[1]!);
      response.writeHead(204).end();
      throw undefined;
    },
  });

  /** Ends every session in a room (the room was closed or the invite revoked). Returns how many connections it had. */
  function closeRoom(roomId: string): void {
    const name = `room:${roomId}`;
    closed.add(1, { reason: 'room-closed' });
    server.hocuspocus.closeConnections(name);
  }

  const sweep = setInterval(() => {
    const n = sessions.sweep(now());
    if (n) closed.add(n, { reason: 'session-ended-sweep' });
  }, opts.sweepMs ?? 30_000);
  sweep.unref();
  // Live claims are kept alive; those of an instance that dies run out after the claim's lifetime.
  const keepClaims = claims
    ? setInterval(() => void owners.refresh(), Math.floor(claims.ttlMs / 4))
    : undefined;
  keepClaims?.unref();

  return {
    server,
    sessions,
    closeRoom,
    listen: () => server.listen(),
    get webSocketURL() {
      return server.webSocketURL;
    },
    get httpURL() {
      return server.httpURL;
    },
    async destroy() {
      clearInterval(sweep);
      clearInterval(keepClaims);
      await server.destroy();
    },
  };
}
