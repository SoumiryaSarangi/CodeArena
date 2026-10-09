import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CollabIdentity } from '@codearena/contracts';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createServer } from './server';

// ---- a stand-in for the API: the contract of POST /api/internal/rooms/{id}/authorize ----------------------------
const SERVICE_TOKEN = 'x'.repeat(40);

interface Api {
  url: string;
  calls: { room: string; ticket: string; token: string | undefined }[];
  /** ticket → what the API would answer; a ticket is single use, like the real one. */
  tickets: Map<string, CollabIdentity>;
  mode: 'normal' | 'down' | 'error' | 'garbage';
  close: () => Promise<void>;
}

async function startApi(): Promise<Api> {
  const api: Api = {
    url: '',
    calls: [],
    tickets: new Map(),
    mode: 'normal',
    close: async () => {},
  };
  const http: HttpServer = createHttp((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const room = /\/rooms\/([^/]+)\/authorize$/.exec(req.url ?? '')?.[1] ?? '';
      const ticket = (JSON.parse(raw || '{}') as { ticket?: string }).ticket ?? '';
      api.calls.push({ room, ticket, token: req.headers['x-service-token'] as string | undefined });
      if (api.mode === 'error') return void res.writeHead(500).end();
      if (api.mode === 'garbage')
        return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":1}');
      const who = api.tickets.get(ticket);
      if (!who || req.headers['x-service-token'] !== SERVICE_TOKEN)
        return void res.writeHead(401).end();
      api.tickets.delete(ticket);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(who));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  api.url = `http://127.0.0.1:${port}`;
  api.close = () => new Promise<void>((r) => http.close(() => r()));
  return api;
}

// ---- helpers ---------------------------------------------------------------------------------------------------
const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const quiet = async (ms = 250) => new Promise((r) => setTimeout(r, ms));

const roomA = randomUUID();
const roomB = randomUUID();
let seq = 0;

describe('CP-01: the collab server', () => {
  let api: Api;
  let collab: ReturnType<typeof createServer>;
  let clock = Date.now();
  const providers: HocuspocusProvider[] = [];

  const start = async (sweepMs = 60_000) => {
    api = await startApi();
    collab = createServer({
      port: 0,
      api: { url: api.url, token: SERVICE_TOKEN, timeoutMs: 800 },
      token: SERVICE_TOKEN,
      now: () => clock,
      sweepMs,
    });
    await collab.listen();
  };
  afterEach(async () => {
    for (const p of providers.splice(0)) p.destroy();
    await collab?.destroy();
    await api?.close().catch(() => undefined);
    clock = Date.now();
  });

  /** A person with a verified identity in the room: the API will recognise their ticket once. */
  const person = (
    role: CollabIdentity['role'],
    name: string,
    over: Partial<CollabIdentity> = {},
  ): { ticket: string; identity: CollabIdentity } => {
    const identity: CollabIdentity = {
      userId: randomUUID(),
      name,
      role,
      readOnly: role === 'observer',
      expiresAt: clock + 60 * 60_000,
      colorIndex: seq++ % 8,
      ...over,
    };
    const ticket = `t-${randomUUID()}`;
    api.tickets.set(ticket, identity);
    return { ticket, identity };
  };

  const join = (room: string, ticket: string, doc = new Y.Doc()) => {
    const state = { failed: false, synced: false, closeReason: null as string | null };
    const provider = new HocuspocusProvider({
      url: collab.webSocketURL,
      name: `room:${room}`,
      document: doc,
      token: ticket,
      onAuthenticationFailed: () => (state.failed = true),
      onSynced: () => (state.synced = true),
      onClose: ({ event }) => (state.closeReason = event.reason ?? ''),
    });
    providers.push(provider);
    return { provider, doc, state, text: doc.getText('code'), awareness: provider.awareness! };
  };
  const serverText = (room: string) =>
    collab.server.hocuspocus.documents.get(`room:${room}`)?.getText('code').toString();

  it('FR-PAD-03: a ticket the API does not know is rejected, and nothing is shared with the client', async () => {
    await start();
    const a = join(roomA, 'not-a-ticket');
    await until(() => a.state.failed);
    expect(a.state.synced).toBe(false);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      room: roomA,
      ticket: 'not-a-ticket',
      token: SERVICE_TOKEN,
    });
  });

  it('FR-PAD-03: a ticket is single use: the same one cannot join twice', async () => {
    await start();
    const p = person('candidate', 'asha');
    const first = join(roomA, p.ticket);
    await until(() => first.state.synced);
    const second = join(roomA, p.ticket);
    await until(() => second.state.failed);
    expect(second.state.synced).toBe(false);
  });

  it('FR-PAD-03: an API that is down, answers 500 or answers nonsense never lets anyone in', async () => {
    await start();
    for (const mode of ['error', 'garbage'] as const) {
      api.mode = mode;
      const c = join(roomA, person('candidate', 'asha').ticket);
      await until(() => c.state.failed);
      expect(c.state.synced).toBe(false);
    }
    await api.close();
    const d = join(roomA, 'whatever');
    await until(() => d.state.failed);
    expect(d.state.synced).toBe(false);
  });

  it('FR-PAD-03: only documents named room:{uuid} exist; anything else is refused without asking the API', async () => {
    await start();
    const provider = new HocuspocusProvider({
      url: collab.webSocketURL,
      name: 'lobby',
      document: new Y.Doc(),
      token: 'x',
    });
    providers.push(provider);
    let failed = false;
    provider.on('authenticationFailed', () => (failed = true));
    await until(() => failed);
    expect(api.calls).toHaveLength(0);
  });

  it('the interviewer and the candidate share the code; two rooms never mix', async () => {
    await start();
    const iv = join(roomA, person('interviewer', 'meera').ticket);
    const cd = join(roomA, person('candidate', 'asha').ticket);
    const other = join(roomB, person('interviewer', 'zed').ticket);
    await until(() => iv.state.synced && cd.state.synced && other.state.synced);
    iv.text.insert(0, 'int main() {}');
    await until(() => cd.text.toString() === 'int main() {}');
    cd.text.insert(0, '// ');
    await until(() => iv.text.toString() === '// int main() {}');
    await quiet();
    expect(other.text.toString()).toBe('');
    expect(serverText(roomB)).toBe('');
  });

  it("FR-PAD-03: an observer's edits are ignored (server and everyone else unchanged), but the observer sees the others' edits", async () => {
    await start();
    const iv = join(roomA, person('interviewer', 'meera').ticket);
    const ob = join(roomA, person('observer', 'ravi').ticket);
    await until(() => iv.state.synced && ob.state.synced);
    iv.text.insert(0, 'hello');
    await until(() => ob.text.toString() === 'hello');
    ob.text.insert(5, ' EVIL');
    ob.text.insert(0, 'x');
    await quiet(400);
    expect(serverText(roomA)).toBe('hello');
    expect(iv.text.toString()).toBe('hello');
    iv.text.insert(5, ' world');
    await until(() => ob.text.toString().includes(' world'));
  });

  it('FR-PAD-04: a spoofed awareness identity is replaced with the verified one; the cursor is kept', async () => {
    await start();
    const iv = join(roomA, person('interviewer', 'meera', { colorIndex: 1 }).ticket);
    const cd = join(roomA, person('candidate', 'asha', { colorIndex: 4 }).ticket);
    await until(() => iv.state.synced && cd.state.synced);
    cd.awareness.setLocalState({
      user: {
        name: 'Admin',
        role: 'interviewer',
        colorIndex: 7,
        color: '#ff0000',
        id: 'someone-else',
      },
      cursor: { anchor: 3, head: 5 },
    });
    await until(() => {
      const seen = iv.awareness.getStates().get(cd.doc.clientID);
      return !!seen && 'cursor' in seen;
    });
    const seen = iv.awareness.getStates().get(cd.doc.clientID)!;
    expect(seen.user).toEqual({ name: 'asha', role: 'candidate', colorIndex: 4 });
    expect(seen.cursor).toEqual({ anchor: 3, head: 5 });
  });

  it("FR-PAD-04: a connection cannot overwrite or remove another connection's presence", async () => {
    await start();
    const victim = join(roomA, person('interviewer', 'meera', { colorIndex: 0 }).ticket);
    const watcher = join(roomA, person('observer', 'ravi').ticket);
    await until(() => victim.state.synced && watcher.state.synced);
    victim.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    await until(() => !!watcher.awareness.getStates().get(victim.doc.clientID)?.cursor);

    // the attacker writes the victim's client id: first a rewrite, then a removal
    const doc = new Y.Doc();
    doc.clientID = victim.doc.clientID;
    const attacker = join(roomA, person('candidate', 'mallory').ticket, doc);
    await until(() => attacker.state.synced);
    attacker.awareness.setLocalState({
      user: { name: 'meera-the-fake' },
      cursor: { anchor: 99, head: 99 },
    });
    await quiet(400);
    expect(watcher.awareness.getStates().get(victim.doc.clientID)).toMatchObject({
      user: { name: 'meera', role: 'interviewer' },
      cursor: { anchor: 1, head: 1 },
    });
    attacker.awareness.setLocalState(null);
    await quiet(400);
    expect(watcher.awareness.getStates().get(victim.doc.clientID)?.user?.name).toBe('meera');
  });

  it('FR-PAD-04: an awareness state over 4 KB is dropped, not relayed', async () => {
    await start();
    const iv = join(roomA, person('interviewer', 'meera').ticket);
    const cd = join(roomA, person('candidate', 'asha').ticket);
    await until(() => iv.state.synced && cd.state.synced);
    cd.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    await until(() => !!iv.awareness.getStates().get(cd.doc.clientID)?.cursor);
    cd.awareness.setLocalState({ blob: 'z'.repeat(10_000) });
    await quiet(400);
    expect(JSON.stringify([...iv.awareness.getStates().values()])).not.toContain('zzzz');
  });

  it('FR-PAD-05: a message after the session ended closes the connection and is not applied', async () => {
    await start();
    const iv = join(
      roomA,
      person('interviewer', 'meera', { expiresAt: clock + 10 * 60_000 }).ticket,
    );
    const cd = join(roomA, person('candidate', 'asha', { expiresAt: clock + 10 * 60_000 }).ticket);
    await until(() => iv.state.synced && cd.state.synced);
    iv.text.insert(0, 'a');
    await until(() => serverText(roomA) === 'a');
    clock += 11 * 60_000; // the session is over
    iv.text.insert(1, 'b');
    await until(() => iv.state.closeReason === 'session-ended');
    expect(serverText(roomA)).toBe('a');
    expect(cd.text.toString()).toBe('a');
  });

  it('FR-PAD-05: an idle connection is closed when its session ends, without sending anything', async () => {
    await start(40);
    const cd = join(roomA, person('candidate', 'asha', { expiresAt: clock + 5 * 60_000 }).ticket);
    await until(() => cd.state.synced);
    expect(collab.sessions.size).toBe(1);
    clock += 6 * 60_000;
    await until(() => cd.state.closeReason === 'session-ended');
    expect(collab.sessions.size).toBe(0);
  });

  it('closeRoom ends the sessions of that room only', async () => {
    await start();
    const a1 = join(roomA, person('interviewer', 'meera').ticket);
    const a2 = join(roomA, person('candidate', 'asha').ticket);
    const b1 = join(roomB, person('interviewer', 'zed').ticket);
    await until(() => a1.state.synced && a2.state.synced && b1.state.synced);
    collab.closeRoom(roomA);
    await until(() => a1.state.closeReason !== null && a2.state.closeReason !== null);
    await quiet();
    expect(b1.state.closeReason).toBeNull();
    b1.text.insert(0, 'still here');
    await until(() => serverText(roomB) === 'still here');
  });

  it('the internal close route needs the service token', async () => {
    await start();
    const a1 = join(roomA, person('interviewer', 'meera').ticket);
    await until(() => a1.state.synced);
    const post = (headers: Record<string, string>, path = `/internal/rooms/${roomA}/close`) =>
      fetch(`${collab.httpURL}${path}`, { method: 'POST', headers });
    expect((await post({})).status).toBe(401);
    expect((await post({ 'x-service-token': 'y'.repeat(40) })).status).toBe(401);
    await quiet();
    expect(a1.state.closeReason).toBeNull();
    expect((await post({ 'x-service-token': SERVICE_TOKEN })).status).toBe(204);
    await until(() => a1.state.closeReason !== null);
  });
});
