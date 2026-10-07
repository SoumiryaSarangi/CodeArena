# API image (D-02). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t codearena-api .
# The API runs TypeScript directly with tsx (its source uses extensionless ESM imports, so a plain
# tsc build would not run), against the workspace packages it needs (contracts).
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS deps
# Manifests first so the install layer is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@codearena/api..." --ignore-scripts

FROM deps AS app
# `config` holds the tsconfig the API extends: without it tsx loses the decorator settings and fails.
COPY packages/contracts packages/contracts
COPY packages/config packages/config
COPY apps/api apps/api
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
WORKDIR /repo/apps/api
# Start node directly, not through pnpm: pnpm re-checks and reinstalls dependencies on every run, which
# a non-root container user cannot do (and a running server should never do). The migrate job reuses
# this image: node --import tsx src/db/cli.ts migrate
CMD ["node", "--import", "tsx", "src/main.ts"]
