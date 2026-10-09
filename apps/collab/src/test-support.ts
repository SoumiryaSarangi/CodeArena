import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import type { CollabIdentity } from '@codearena/contracts';

// ---- a stand-in for the API: the contract of POST /api/internal/rooms/{id}/authorize ----------------------------
export const SERVICE_TOKEN = 'x'.repeat(40);

export interface Api {
  url: string;
  calls: { room: string; ticket: string; token: string | undefined }[];
  /** ticket → what the API would answer; a ticket is single use, like the real one. */
  tickets: Map<string, CollabIdentity>;
  mode: 'normal' | 'down' | 'error' | 'garbage';
  close: () => Promise<void>;
}

export async function startApi(): Promise<Api> {
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

/** Polls until `fn` is true, or fails after `ms`. */
export const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};
export const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));
