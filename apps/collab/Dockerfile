# Collab image (CP-03). Build from the repository root:
#   docker build -f apps/collab/Dockerfile -t codearena-collab .
# Same approach as the API image: TypeScript runs directly with tsx, against the workspace packages it needs.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab/package.json apps/collab/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@codearena/collab..." --prod --ignore-scripts

FROM deps AS app
COPY packages/contracts packages/contracts
COPY packages/config packages/config
COPY apps/collab apps/collab
ENV NODE_ENV=production PORT=1234
EXPOSE 1234
USER node
WORKDIR /repo/apps/collab
# Needs DATABASE_URL, REDIS_URL, API_URL and COLLAB_SERVICE_TOKEN; it refuses to start without them. SIGTERM flushes the
# open documents to Postgres before exiting. Node directly, not through pnpm (see the API image).
CMD ["node", "--import", "tsx", "src/main.ts"]
