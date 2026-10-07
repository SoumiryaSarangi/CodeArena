# Live end-to-end spec (UI-02)

Runs the real stack: browser → web → API → Redis queue → judge worker → verdict over SSE.
It is not part of `pnpm e2e` (that suite stubs the API and runs anywhere).

```
docker compose up -d && scripts/dev-up.sh           # postgres, redis, s3
pnpm problem:import --publish problems/             # the 20 practice problems
pnpm --filter @codearena/api dev                    # API on :4000
(cd apps/worker && REDIS_URL=redis://judge:judge-dev@localhost:6379 \
  S3_ENDPOINT=http://localhost:8333 S3_BUCKET=codearena S3_ACCESS_KEY=codearena \
  S3_SECRET_KEY=codearena-dev WORKER_ID=live-w1 go run .)   # a judge (isolate + runtimes set up)
E2E_LIVE=1 pnpm --filter @codearena/web e2e:live
```

The spec mints its own user and refresh token with `apps/api/src/test/mint-session.ts`, so it does
not need Google or GitHub. The dev passwords above are the Compose defaults; use your own if you
changed them.

## The setter screen spec (UI-04)

`e2e/live/admin.spec.ts` uploads a copy of `problems/hop-distances` through the page as a minted
**setter** (`mint-session.ts '' setter`), presses Validate and expects the real judge to confirm all
eight items (seven solutions and the validator). Two things to know when running it:

- Start the worker with **every lane**: `WORKER_LANES=contest,interactive,practice,rejudge`
  (validation jobs use the `rejudge` lane; the default is `practice` only).
- The dev database needs the latest migration: `pnpm --filter @codearena/api db:migrate`.

`E2E_LIVE=1 pnpm --filter @codearena/web e2e:live` runs both live specs; `... admin` only this one.
