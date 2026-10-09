import { timingSafeEqual } from 'node:crypto';
import {
  CollabRestoreRequest,
  ROOM_DOC_MAX_BYTES,
  type CollabIdentity,
} from '@codearena/contracts';
import { Database } from '@hocuspocus/extension-database';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { isTransactionOrigin, Server, type Extension } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { Redis } from 'ioredis';
import { metrics, trace } from '@opentelemetry/api';
import { authorizeTicket, type ApiLink } from './auth';
import { RedisClaims } from './claims';
import { AwarenessOwners, rewriteAwareness, roomIdOf } from './identity';
import { CLOSE_DOC_TOO_LARGE, DocSizeGuard } from './doc-size';
import { restoreSnapshot } from './restore';
import { CLOSE_SESSION_ENDED, Sessions } from './session';
import type { DocStore } from './store';
import type { UpdateLog } from './update-log';

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
const restores = meter.createCounter('ca_collab_restores_total', {
  description: 'Snapshots put back into a room document',
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
  /** The room's history: every update, checkpoints and join/leave/language events, for the replay (CP-06). */
  log?: UpdateLog;
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
  /** The most Yjs state a room's document may hold (FR-PAD-13); a test seam, the default is the contract's. */
  maxDocBytes?: number;
}

/** What `onAuthenticate` puts on the connection: everything the rest of the server may believe about the client. */
export interface CollabContext {
  identity: CollabIdentity;
}

const RESTORE_BODY_MAX = 400 * 1024;

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
  const docSize = new DocSizeGuard(opts.maxDocBytes ?? ROOM_DOC_MAX_BYTES);

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
      const roomId = roomIdOf(data.documentName);
      if (opts.log && roomId) void opts.log.event(roomId, 'join', data.context.identity.userId);
    },

    async beforeHandleMessage(data) {
      if (now() > data.context.identity.expiresAt) {
        sessions.remove(data.socketId);
        closed.add(1, { reason: 'session-ended-message' });
        data.connection.close(CLOSE_SESSION_ENDED);
        throw new Error('session ended');
      }
      if (!docSize.allows(data.document, data.update)) {
        closed.add(1, { reason: 'document-too-large' });
        data.connection.close(CLOSE_DOC_TOO_LARGE);
        throw new Error('document too large');
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

    // CP-06: what the replay is made of. All of it is off the editing path and never throws at the editor.
    async onChange(data) {
      const log = opts.log;
      const roomId = roomIdOf(data.documentName);
      if (!log || !roomId) return;
      // an update relayed from another instance is logged by the instance that received it
      if (isTransactionOrigin(data.transactionOrigin) && data.transactionOrigin.source === 'redis')
        return;
      log.record(roomId, {
        update: data.update,
        ts: new Date(),
        userId: data.context?.identity?.userId ?? null,
      });
    },

    async afterLoadDocument(data) {
      const log = opts.log;
      const roomId = roomIdOf(data.documentName);
      if (!log || !roomId) return;
      // after a crash or a restart the log may be behind the stored document: close the gap before anyone edits
      await log.reconcile(roomId, Y.encodeStateAsUpdate(data.document));
      data.document.getMap('meta').observe((event, txn) => {
        if (!event.keysChanged.has('language')) return;
        const origin = txn.origin;
        if (isTransactionOrigin(origin) && origin.source === 'redis') return;
        const ctx =
          isTransactionOrigin(origin) && 'connection' in origin
            ? origin.connection?.context
            : isTransactionOrigin(origin) && origin.source === 'local'
              ? origin.context // a restore the API asked for (CP-07)
              : undefined;
        const who = (ctx as CollabContext | undefined)?.identity?.userId ?? null;
        void log.event(roomId, 'language', who, {
          language: data.document.getMap('meta').get('language') ?? null,
        });
      });
    },

    async beforeUnloadDocument(data) {
      const log = opts.log;
      const roomId = roomIdOf(data.documentName);
      if (!log || !roomId) return;
      await log.reconcile(roomId, Y.encodeStateAsUpdate(data.document));
    },

    async onDisconnect(data) {
      await owners.release(data.documentName, data.socketId);
      if (sessions.remove(data.socketId)) {
        open.add(-1);
        const roomId = roomIdOf(data.documentName);
        const who = (data.context as CollabContext | undefined)?.identity.userId ?? null;
        if (opts.log && roomId) void opts.log.event(roomId, 'leave', who);
      }
    },

    // Internal HTTP, for the API: `POST /internal/rooms/{roomId}/close` ends every session in that room (CP-02);
    // `POST /internal/rooms/{roomId}/restore` puts a snapshot's code back (CP-07).
    async onRequest({ request, response }) {
      const m = /^\/internal\/rooms\/([0-9a-f-]{36})\/(close|restore)$/.exec(
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
      if (m[2] === 'close') {
        closeRoom(m[1]!);
        response.writeHead(204).end();
        throw undefined;
      }
      await handleRestore(m[1]!, request, response);
      throw undefined;
    },
  });

  async function handleRestore(
    roomId: string,
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) {
    const send = (code: number, body?: object) => {
      response
        .writeHead(code, body ? { 'content-type': 'application/json' } : {})
        .end(body ? JSON.stringify(body) : undefined);
    };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of request) {
      size += (c as Buffer).length;
      if (size > RESTORE_BODY_MAX) return send(413);
      chunks.push(c as Buffer);
    }
    let body: CollabRestoreRequest;
    try {
      body = CollabRestoreRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      return send(400);
    }
    // The context is what the update log attributes the change to: the interviewer who asked, not "the server".
    const identity = {
      userId: body.userId,
      role: 'interviewer',
      readOnly: false,
    } as CollabIdentity;
    try {
      const edits = await tracer.startActiveSpan('collab.restore', async (span) => {
        try {
          return await restoreSnapshot(server.hocuspocus, roomId, body, { identity });
        } finally {
          span.end();
        }
      });
      restores.add(1);
      send(200, { edits });
    } catch (err) {
      console.warn('collab: restore failed', err instanceof Error ? err.message : err);
      send(500);
    }
  }

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
