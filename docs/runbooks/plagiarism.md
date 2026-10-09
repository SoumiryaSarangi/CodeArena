# Plagiarism check (PL-05)

What it does: after a contest has ended, an admin starts a check; a separate job scores every problem's final
submissions (fingerprints + embeddings, SD-§13) and posts pairs and clusters for a person to review. **Nothing is decided
automatically** and nothing changes a score or a ranking.

## The pieces

- **API** (`apps/api/src/modules/plag`): `POST /api/admin/plag/runs {contestId, params?}` queues a run (admin; the contest
  must have ended; one run at a time per contest; audited), `GET /api/admin/plag/runs[?contestId=]` and
  `GET /api/admin/plag/runs/{id}` read runs and their clusters. The job's three calls use the **service token** in the
  `X-Service-Token` header (not a user session): `POST .../claim` (200 with the work, 204 when none), `POST .../{id}/results`,
  `POST .../{id}/fail`. A run the job started but never finished (it died) is taken over after `PLAG_STALE_MINUTES` (30).
  Without `PLAG_SERVICE_TOKEN` in the API's environment those three answer 403 "not configured".
- **Job** (`apps/plag`, `python -m plag serve --api URL`): polls the API, scores, posts; a crash is reported with `/fail`.
  It sees opaque person ids, never a handle or e-mail. Image: `apps/plag/Dockerfile` (CPU-only torch, the UniXcoder
  model baked in, runs as a non-root user).
- **Compose** (`infra/prod/docker-compose.yml`, service `plag`, profile `plag`): **off unless asked for**; no database,
  Redis or storage access, read-only, 1 CPU and 2 GB at most so it cannot starve the API.

## Turning it on (once, on the API VM; not done yet)

1. The token. A new install already has `PLAG_SERVICE_TOKEN` in `prod.env`. An existing one:
   `ssh codearena@<api> 'cd /opt/codearena && ./init-env.sh ensure prod PLAG_SERVICE_TOKEN $(openssl rand -hex 24)'`
   then restart the API (`docker compose ... up -d --force-recreate api`) so it reads it.
2. The image: build `apps/plag` (about 4 GB with the model; a few minutes), push it somewhere the VM can pull from, or build
   it on the VM. Deploying it through the pipeline is not set up (a follow-up).
3. Start it: `PLAG_IMAGE=<image> docker compose --env-file prod.env --profile plag up -d plag`. `docker compose logs -f plag`
   prints each run ("run <id>: done").

## Running a check

Start the run (until the review screen exists, with the API): `POST /api/admin/plag/runs` as an admin with the contest id.
The job picks it up within 15 s. `GET /api/admin/plag/runs/{id}` shows `queued` → `running` → `done` (with clusters, strongest
first) or `failed` (with the reason). A failed run can be started again. Scores: pairs with a combined score of at least
0.30 are listed, pairs at or above 0.54 form clusters (the fitted threshold, `docs/METRICS.md` has its precision: about one
flag in nine is a false alarm).

## When something is wrong

| Symptom | Look at |
|---|---|
| The run stays `queued` | The job is not running (`docker compose --profile plag ps`), or its token does not match the API's (`403`/`401` in `docker compose logs plag`) |
| `failed` with a model error | The image was built without the model; rebuild, the model is downloaded at build time |
| `running` for more than 30 minutes | The job died: the next claim takes the run over by itself |
| Results refused (400) | The job and API disagree on the submissions of the run; start a new run |
