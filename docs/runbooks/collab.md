# Interview pad: the collab servers

Two Hocuspocus servers (`collab1`, `collab2`) behind Caddy's `/collab/{roomId}` route (URI hash, so a room normally lives on
one of them). They store documents in Postgres (`room_docs`), share edits through Redis, and ask the API who a ticket belongs
to (`POST /api/internal/rooms/{id}/authorize`, which the edge does **not** serve to outsiders). Design: SYSTEM_DESIGN §11.

## Turning it on (the pipeline does it)

Nothing runs until you set the repository variable, and the pad shows "Joining the room…" until then.

1. `gh variable set COLLAB_ENABLED --body true`, then merge or dispatch a deploy of `main`. After the API deploy has succeeded
   two extra jobs run (both `continue-on-error`: a failure here never fails or rolls back an API or judge deploy):
   - `collab-image` builds `apps/collab/Dockerfile` and pushes `ghcr.io/<owner>/codearena-collab:<sha>`;
   - `deploy-collab` runs `infra/prod/deploy-collab.sh` on the API VM: adds `COLLAB_SERVICE_TOKEN` and `COLLAB_URL` to
     `prod.env` if missing (and recreates the API once so it reads them), pulls the image by digest, updates `collab1`, waits
     until it is healthy, then `collab2`. If an instance does not become healthy, **both** go back to the previous image (or
     stop, when there was none).
2. In Vercel, set `NEXT_PUBLIC_COLLAB_URL` to `wss://api.40-83-75-34.sslip.io/collab` (the API's public host, plus `/collab`; the
   same host as `NEXT_PUBLIC_REALTIME_URL`, with `wss`) and redeploy the web app: the value is inlined at build time.
3. Check: `curl -s https://api.40-83-75-34.sslip.io/collab/x` no longer says "not available" (a plain GET answers 200 or a
   WebSocket error text from Hocuspocus, not the 503), `curl -s -X POST https://api.40-83-75-34.sslip.io/api/internal/rooms/3f2a0000-0000-4000-8000-000000000000/authorize`
   answers 404 "Not found" (the edge hides it), and a room at `/interview` opens with two people editing together.

## Looking at it

```bash
ssh codearena@<api> 'cd /opt/codearena && export API_IMAGE=$(cat state/current) COLLAB_IMAGE=$(cat state/collab-current) && \
  docker compose --env-file prod.env --profile collab ps && docker compose --env-file prod.env --profile collab logs --tail 50 collab1'
```

Metrics (`ca_collab_*`) are not exported yet: the collab process has no OpenTelemetry SDK (follow-up).

## Turning it off

`gh variable set COLLAB_ENABLED --body false` stops future deploys from updating it; it does not stop what runs. To stop the
servers: `docker compose --env-file prod.env --profile collab stop collab1 collab2` (each flushes its open documents to
Postgres within the 20 s grace period). The pad then shows "Joining the room…" again and nothing else is affected.

## When something is wrong

| Symptom | Look at |
|---|---|
| Pad stuck on "Joining the room…" | Is `NEXT_PUBLIC_COLLAB_URL` set and the web app redeployed? Are both instances `healthy`? Does `/collab/x` still answer the 503 text (no instance up)? |
| "You cannot join this room right now" | The ticket was refused: the room ended, the person is not a member, or `COLLAB_SERVICE_TOKEN` differs between the API and collab (`403/401` in the collab logs) |
| One instance restarts in a loop | Its logs: `DATABASE_URL`/`REDIS_URL` empty (it refuses to start), or Postgres/Redis unreachable |
| Edits seem to vanish after a restart | Look for `could not store` in the logs; a failed store keeps the document in memory, and clients re-send theirs when they reconnect |
| Cursors missing for some people | Redis down or `hocuspocus:own:*` claims stuck (they expire after 2 minutes) |

## Measuring capacity (CP-08)

`pnpm --filter @codearena/collab pad-load -- --rooms 10 --typists 3 --seconds 60 --label "10 rooms × 3" --out /tmp/pad.json`, then
`node scripts/metrics-report.mjs --pad /tmp/pad.json` adds the result to `docs/METRICS.md`. It runs on a developer machine against
the Compose Postgres and Redis and never touches production. See `tests/load/README.md` for what it measures and how far to trust it.
The convergence guarantee itself is tested without a network by `apps/collab/src/convergence.test.ts` (random concurrent edits,
restores and reordered, repeated delivery on 3 to 5 replicas), and the loss of an instance by `chaos.test.ts`.

## Demo: offline editing (CP-09)

1. Two browsers in one room (the interviewer and a candidate), both typing a line so everyone sees it.
2. Stop the pad servers: `docker compose stop collab1 collab2` (locally), or block the room's WebSocket in the browser's network panel. Within a few seconds the candidate's page shows "The connection to the room was lost. Keep typing: your changes are saved on this device…" and the pill says Reconnecting.
3. The candidate keeps typing, then **reloads the page**. The code they typed is still there (it was kept in the browser); the banner stays.
4. The interviewer types something else meanwhile (if the servers were only blocked for the candidate).
5. Start the servers again (`docker compose start collab1 collab2`): both pages end with both people's text, identical, with nothing lost, and the banner disappears.
6. Press End room: the copy kept in the browser is removed (DevTools → Application → IndexedDB no longer lists `codearena-pad:…`).

What it cannot do: open a room with no network at all (the page needs the API). That would need a service worker, which is not planned.

