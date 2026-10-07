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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@codearena/api..." --ignore-scripts

FROM deps AS app
COPY packages/contracts packages/contracts
COPY apps/api apps/api
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
WORKDIR /repo/apps/api
# `migrate` and the import tool reuse this image: docker compose run --rm api pnpm db:migrate
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
