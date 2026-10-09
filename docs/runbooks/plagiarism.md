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

## Turning it on (PL-06; off until you do this)

The pipeline does it. Set the repository variable `PLAG_ENABLED` to `true` (Settings → Secrets and variables → Actions →
Variables, or `gh variable set PLAG_ENABLED --body true`). From the next deploy of `main`, after the API deploy has
succeeded, two extra jobs run:

1. `plag-image` builds `apps/plag` (about 4 GB with the model; the first build takes several minutes, later ones use the
   cache) and pushes `ghcr.io/<owner>/codearena-plag:<sha>`.
2. `deploy-plag` runs `infra/prod/deploy-plag.sh` on the API VM: adds `PLAG_SERVICE_TOKEN` to `prod.env` if it is missing
   (and recreates the API once so it reads it), pulls the image by digest, starts the `plag` service, waits 20 s and checks
   it is still running. If not, the previous image is put back (or the job is stopped when there was none).

Both jobs are `continue-on-error` and nothing waits for them: a failure here never fails or rolls back an API or judge
deploy. Do not turn it on the day of a contest (the first run pulls 4 GB and uses 1 CPU / 2 GB on the API VM).
To turn it off: set `PLAG_ENABLED` to `false`; to stop the running job:
`ssh codearena@<api> 'cd /opt/codearena && docker compose --env-file prod.env --profile plag stop plag'`.
`docker compose --env-file prod.env --profile plag logs -f plag` prints each run ("run <id>: done").

## Running a check

Admin → Integrity (`/admin/integrity`): pick a contest that has ended and press **Start check**. (API: `POST /api/admin/plag/runs`.)
The job picks it up within 15 s; the review page shows "Waiting for the job" → "Checking" → the groups of similar submissions
(strongest first), or "Failed" with the reason (start it again from the list). Scores: pairs with a combined score of at least
0.30 are listed, pairs at or above 0.54 form groups (the fitted threshold, `docs/METRICS.md` has its precision: about one
flag in nine is a false alarm).

## Reviewing

Open a group: its people and pairs are listed, the two chosen submissions are shown side by side, and the editor signals are
shown separately as advisory. Write a note (required) and press **Clear**, **Confirm similar** or **Needs discussion**.
A decision is only a record (with who and when, also in the audit log): it changes no score, no ranking and no account. Later
decisions on the same group are added to the trail; the latest one is the status.

## When something is wrong

| Symptom | Look at |
|---|---|
| The run stays `queued` | The job is not running (`docker compose --profile plag ps`), or its token does not match the API's (`403`/`401` in `docker compose logs plag`) |
| `failed` with a model error | The image was built without the model; rebuild, the model is downloaded at build time |
| `running` for more than 30 minutes | The job died: the next claim takes the run over by itself |
| Results refused (400) | The job and API disagree on the submissions of the run; start a new run |
