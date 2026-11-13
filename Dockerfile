# syntax=docker/dockerfile:1
#
# Production image for the Blockbase MCP server, run over the authenticated
# Streamable HTTP transport added in M1/M2 (packages/mcp/src/server.ts
# startHttpServer). Two stages:
#   1. `build`  - full workspace install (incl. devDependencies) + `pnpm build`,
#                 then `pnpm deploy --prod` bundles the CLI package plus only
#                 its production dependencies into a self-contained folder.
#   2. runtime  - a bare Node 24 base plus that deployed folder. No
#                 devDependencies, no TypeScript sources, no build tooling,
#                 no catalog data, and it runs as a non-root user.
#
# The catalog root is NEVER baked into this image. It is a runtime bind
# mount / named volume at /data/catalog (see VOLUME below and
# BLOCKBASE_HOME, which packages/core/src/catalog/discovery.ts already reads
# to resolve the catalog root - no server code changes needed here).
#
# BLOCKBASE_MCP_TOKEN is required at runtime and must be supplied by the
# operator (`docker run -e BLOCKBASE_MCP_TOKEN=...` or a secret/env file) -
# it is never present in this file, in .dockerignore, or in the image.

ARG NODE_VERSION=24.11.1
ARG PNPM_VERSION=12.3.4

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
# `npm install -g` (rather than `corepack prepare --activate`) so the exact
# pinned pnpm binary is fully present in this layer - no lazy download on
# first invocation in a later, separate RUN layer.
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
WORKDIR /app

# ---------------------------------------------------------------------------
# Build stage: full workspace, devDependencies included, produces dist/ for
# every package and a pruned production deployment of @blockbase/cli.
# ---------------------------------------------------------------------------
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# The CLI build copies the agent payload from here (packages/cli/scripts/copy-agent-payload.mjs).
COPY integrations ./integrations

RUN pnpm install --frozen-lockfile
RUN pnpm run build

# `pnpm deploy` bundles @blockbase/cli plus only its production dependencies
# (which pull in @blockbase/contracts, @blockbase/core, @blockbase/mcp
# and @blockbase/preview as plain, already-built node_modules entries - no
# workspace:* symlinks, no devDependencies; the image therefore also carries the
# preview's dependencies, which `blockbase mcp` itself never loads) into a standalone
# folder that needs nothing else from the monorepo to run.
RUN pnpm --filter @blockbase/cli deploy --prod /app/deploy

# ---------------------------------------------------------------------------
# Runtime stage: nothing but the deployed production bundle, run as a
# non-root user.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

ENV NODE_ENV=production \
    # Documented catalog mount point. Read directly by
    # packages/core/src/catalog/discovery.ts (resolveCatalog/rootFor) - real
    # catalog data must be bind-mounted or volume-mounted here at `docker
    # run` time, never copied into the image.
    BLOCKBASE_HOME=/data/catalog \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

# node:*-slim images already ship an unprivileged "node" user (uid/gid 1000).
# Create the mount point and hand ownership to it before dropping root.
RUN mkdir -p /data/catalog && chown -R node:node /data/catalog /app

COPY --from=build --chown=node:node /app/deploy ./

USER node

VOLUME ["/data/catalog"]
EXPOSE 8080

# Non-secret readiness probe: any HTTP response (this repo's HTTP transport
# returns 401 for the configured MCP path without a bearer token, or 404 for
# any other path/method) proves the process is up, bound to PORT, and
# running its request-handling code - all without the probe itself needing
# BLOCKBASE_MCP_TOKEN. This is deliberately NOT proof that authenticated MCP
# access works; scripts/container-smoke.mjs performs that check separately
# with a real Authorization: Bearer <token> `initialize` call.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||'8080';require('http').get({host:'127.0.0.1',port:p,path:'/mcp',timeout:2000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"]

# Shell form only to allow $HOST/$PORT substitution; exec's the real process
# as PID 1 so SIGTERM (see startHttpServer's process.on('SIGTERM', ...) in
# packages/mcp/src/server.ts) reaches it directly for a clean shutdown.
CMD ["sh", "-c", "exec node dist/index.js mcp --transport http --host \"$HOST\" --port \"$PORT\""]
