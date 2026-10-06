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
