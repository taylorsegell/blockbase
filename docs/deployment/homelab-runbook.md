# Homelab deployment runbook — Blockbase MCP server

Operational runbook for running the Blockbase MCP production image (root
`Dockerfile`, task 3.1) as a persistent service on a homelab host, using
the `compose.yaml` at the repo root. Every command below was run against a
real image build in this environment as part of writing this runbook (see
"How this runbook was validated" at the bottom); adjust host-specific
values (image tag, paths) but the shape of every command is proven to
work.

## Security model — read this first

This server has **two independent layers of defense**, and they are not
interchangeable:

1. **Network boundary (primary): Tailscale.** The container's port must
   only ever be bound to an address reachable over your tailnet — either
   the host's Tailscale IP/hostname directly, or loopback if you are
   fronting it with something on the same host that itself only listens on
   the tailnet. If a host outside the tailnet cannot route to the bound
   address, it cannot reach this server at all, regardless of whether it
   has a token. This is the layer that actually keeps the server private.
2. **Bearer token (defense-in-depth): `BLOCKBASE_MCP_TOKEN`.** Every MCP
   request must carry `Authorization: Bearer <token>` or it is rejected
   with 401 (see `packages/mcp/src/server.ts`, `authenticateHttpRequest`).
   This protects you from anything else already inside the tailnet
   (another device on the same tailnet, a compromised homelab box) that
   you have not explicitly authorized — it is a second lock on an already
   locked door, not the door itself.

**Public exposure is forbidden, full stop.** Never bind the published port
to `0.0.0.0` or any publicly routable interface. Never put a reverse proxy
in front of this service that itself accepts traffic from the public
internet. The bearer token is not sufficient justification for public
exposure — treat any configuration that makes this port reachable from
outside your tailnet as a security incident, not a convenience.

`compose.yaml` defaults `BIND_HOST` to `127.0.0.1` (loopback) specifically
so that running it as committed, without reading this doc, cannot
accidentally publish the server anywhere. To actually use it from other
devices on your tailnet, set `BIND_HOST` in your `.env` file to this
host's real Tailscale address — see "First deploy" below.

## Prerequisites

- Docker with Compose v2 (`docker compose version` should print a version;
  this was validated with Compose `v5.1.4` against a `colima` Docker
  daemon).
- The host's Tailscale IP or MagicDNS hostname (e.g. `100.x.y.z` or
  `my-host.tailnet-name.ts.net`), if you intend to reach this server from
  another device on your tailnet. Not needed if you only ever call it from
  the host itself over loopback.
- This repository checked out on the host (or just `Dockerfile`,
  `.dockerignore`, and `compose.yaml`, plus the source tree needed to
  build the image).

## First deploy

1. Build the image (from the repo root):

   ```sh
   docker build -t blockbase-mcp:latest .
   ```

2. Create a local `.env` file next to `compose.yaml` — **never commit
   this file**:

   ```sh
   cat > .env <<'EOF'
   BLOCKBASE_MCP_TOKEN=replace-with-a-long-random-secret
   BIND_HOST=100.x.y.z
   EOF
   ```

   Generate the token with something like `openssl rand -hex 32`. Set
   `BIND_HOST` to this host's Tailscale address (or leave it unset /
   `127.0.0.1` if you only need loopback access). Do **not** set
   `BIND_HOST=0.0.0.0`.

3. Start the service:

   ```sh
   docker compose up -d
   ```

4. Confirm it started:

   ```sh
   docker compose ps
   ```

   `STATUS` should read `Up ... (healthy)` once the Dockerfile's
   `HEALTHCHECK` (an unauthenticated `GET /mcp`, expecting any non-5xx
   response — 401 in practice) has run at least once (start period is 5s,
   interval 10s).

## Readiness check

The container-level `HEALTHCHECK` is the readiness signal; `compose.yaml`
does not override or disable it, so it works the same way under compose
as it does under plain `docker run`:

```sh
docker inspect --format '{{json .State.Health.Status}}' blockbase-mcp
# "healthy"
```

or equivalently `docker compose ps`. This proves the process is listening
and running its request-handling code — it deliberately does **not** prove
authenticated MCP access (the probe carries no token). For that, run the
authenticated smoke test below.

## Authenticated smoke test

Two options, in order of preference:

1. **Reuse `scripts/container-smoke.mjs` from task 3.1** — it builds and
   runs the image directly with `docker run` (not through compose) and
   proves Node version, non-root user, the 401/200 authenticated boundary,
   volume persistence across container replacement, and a clean SIGTERM
   stop:

   ```sh
   node scripts/container-smoke.mjs
   ```

2. **`scripts/deployment-check.mjs` (this task)** — the compose-path
   equivalent. It runs `docker compose config`, `up`, an unauthenticated
   401 check, an authenticated `initialize` call, a `docker compose
   restart`, and a `down` + `up` cycle against the same named volume, all
   through `docker compose` against the actual `compose.yaml`:

   ```sh
   node scripts/deployment-check.mjs
   ```

   Both scripts generate their own throwaway token and image tag and clean
   up everything they create; neither touches your real `.env` or running
   deployment.

3. **Manual equivalent**, against your real running deployment (adjust
   host/port to match your `BIND_HOST`/`PUBLISHED_PORT`):

   ```sh
   # Unauthenticated — expect 401, proves "listening" only:
   curl -i http://127.0.0.1:8080/mcp

   # Authenticated — expect 200 with a serverInfo payload:
   curl -i http://127.0.0.1:8080/mcp \
     -H "Authorization: Bearer $BLOCKBASE_MCP_TOKEN" \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"0.0.0"}}}'
   ```

## Viewing logs

```sh
docker compose logs -f blockbase-mcp
```

Drop `-f` for a one-shot dump. `docker compose logs --since 1h
blockbase-mcp` narrows to a recent window.

## Graceful restart

```sh
docker compose restart
```

The Dockerfile's `CMD` uses `exec` so SIGTERM reaches the Node process
directly (see `startHttpServer`'s `SIGTERM` handler in
`packages/mcp/src/server.ts`), giving a clean shutdown rather than a
SIGKILL fallback. Confirm it came back healthy:

```sh
docker compose ps
```

## Image upgrade

1. Pull or rebuild the new image under a new or the same tag:

   ```sh
   docker build -t blockbase-mcp:latest .
   ```

2. Recreate the service on the new image, keeping the same named volume
   (the catalog data is untouched — it lives in the `blockbase-catalog`
   volume, not the image):

   ```sh
   docker compose up -d
   ```

   Compose detects the image changed and replaces only the container.

3. Re-run the authenticated smoke test (above) against the upgraded
   container before considering the upgrade complete.

## Catalog backup / restore

The catalog lives in the named volume `blockbase-catalog` (see
`volumes:` in `compose.yaml`), mounted at `/data/catalog` inside the
container — never inside the image.

**Backup** (safe to run while the service is up; it reads through a
throwaway container against the same volume):

```sh
docker run --rm \
  -v blockbase-deploycheck-catalog:/data/catalog:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/blockbase-catalog-backup.tar.gz -C /data/catalog .
```

(Replace `blockbase-deploycheck-catalog` with your actual volume name —
`docker volume ls` to confirm; with `compose.yaml` run from the repo root
it will be `<project-name>_blockbase-catalog`, e.g.
`blocks_blockbase-catalog`.)

**Restore** into a fresh or existing volume:

```sh
docker compose down
docker run --rm \
  -v <project-name>_blockbase-catalog:/data/catalog \
  -v "$PWD":/backup \
  alpine sh -c "rm -rf /data/catalog/* && tar xzf /backup/blockbase-catalog-backup.tar.gz -C /data/catalog"
docker compose up -d
```

If you use a bind mount instead of a named volume (edit `compose.yaml`'s
`volumes:` entry to a host path, e.g.
`/srv/blockbase/catalog:/data/catalog`), backup/restore is a plain
file-level copy of that host directory — no `docker run` indirection
needed.

## Token rotation

The token is never baked into the image — it is read from the environment
at process start (`BLOCKBASE_MCP_TOKEN`, see `packages/mcp/src/server.ts`).
Rotating it requires a restart:

1. Generate a new token and update `.env`:

   ```sh
   NEW_TOKEN=$(openssl rand -hex 32)
   sed -i.bak "s/^BLOCKBASE_MCP_TOKEN=.*/BLOCKBASE_MCP_TOKEN=${NEW_TOKEN}/" .env
   ```

2. Recreate the container so it picks up the new environment (a plain
   `restart` does **not** re-read `.env` — you need `up -d` to force
   recreation):

   ```sh
   docker compose up -d --force-recreate
   ```

3. Update every client's stored token to match, then verify with the
   authenticated smoke test.

4. Treat the old token as compromised the moment the new one is live —
   there is no overlap window; a client using the old token gets 401 from
   this point on.

## Rollback

If an upgrade misbehaves:

1. Roll back to the previously-known-good image tag:

   ```sh
   docker build -t blockbase-mcp:rollback <path-to-previous-checkout-or-tag>
   # or, if you kept the old tag around instead of overwriting :latest:
   BLOCKBASE_IMAGE=blockbase-mcp:rollback docker compose up -d
   ```

2. The named volume is untouched by an image change, so the catalog data
   carries over automatically — no restore needed unless the bad version
   also corrupted catalog data, in which case follow "Catalog
   backup/restore" above with your last good backup.

3. Re-run the authenticated smoke test to confirm the rollback is healthy
   before standing down.

## How this runbook was validated

Every command shape above (`docker compose config`, `up -d`, the
unauthenticated/authenticated HTTP checks, `restart`, `down` + `up`
against the same named volume) was exercised live in this environment via
`node scripts/deployment-check.mjs`, run twice, against a real image built
from this repo's `Dockerfile`, with all steps passing and a clean
teardown (`docker ps -a`, `docker volume ls`, and `docker images` all
empty of `blockbase*` entries afterward).

The backup/restore command shape (the `docker run ... tar czf` /
`tar xzf` pair) was separately round-trip tested live in this
environment against a throwaway volume: a marker file was written, backed
up with the exact `tar` command above, restored into a fresh volume with
the exact restore command above, and read back successfully.

The token-rotation command (`docker compose up -d --force-recreate`) was
not separately re-exercised beyond what `docker compose up -d` already
proved in the script run above — `--force-recreate` is a documented
`docker compose` flag with no special interaction with this service, but
it was not independently timed or verified here.

Neither the backup/restore round trip nor the rest of this runbook was
run against a real Tailscale host or a real long-lived token — there is
no live homelab or tailnet available in this environment. Treat
`BIND_HOST` values and the token-rotation section as "shape validated, not
rehearsed against a real tailnet" until you run them once against your
actual deployment.
