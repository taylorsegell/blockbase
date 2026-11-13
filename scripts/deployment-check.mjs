#!/usr/bin/env node
// Repeatable validation for the homelab compose deployment path (see root
// compose.yaml and docs/deployment/homelab-runbook.md). Complements
// scripts/container-smoke.mjs (task 3.1, which exercises `docker` directly)
// by proving the same claims through `docker compose` specifically, since
// that is what operators actually run day to day:
//
//   1. compose.yaml parses and resolves placeholders sensibly
//      (`docker compose config`), and fails closed when BLOCKBASE_MCP_TOKEN
//      is unset
//   2. `docker compose up -d` brings the service up healthy, bound only to
//      the configured BIND_HOST (loopback by default)
//   3. an unauthenticated request is visibly distinct from an authenticated
//      one, exactly as it is when run without compose
//   4. a real authenticated MCP `initialize` call succeeds through the
//      compose-published port
//   5. `docker compose restart` produces a clean restart back to healthy
//      (the runbook's "graceful restart" step)
//   6. `docker compose down` tears everything down cleanly, and a fresh
//      `docker compose up -d` against the same named volume still has the
//      catalog data (the runbook's upgrade/rollback path relies on this)
//
// Usage: node scripts/deployment-check.mjs
// Requires a working Docker daemon and Docker Compose v2 (`docker compose`).
// Exits non-zero with a clear message at the first failing step; always
// tears down the containers/volume/image it made.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const IMAGE_TAG = 'blockbase-mcp:deployment-check'
const RUN_ID = randomUUID().slice(0, 8)
const PROJECT_NAME = `blockbase-deploycheck-${RUN_ID}`
const SERVICE = 'blockbase-mcp'
const CONTAINER_NAME = `blockbase-mcp`
// Clearly-fake token: never a real secret, matches container-smoke.mjs's
// convention for test fixtures.
const TOKEN = `deployment-check-${RUN_ID}-not-a-real-secret`
const MARKER_VALUE = `compose-round-trip-${RUN_ID}-${Date.now()}`
const HEALTH_TIMEOUT_MS = 30_000

// Fixed host port for this run so we don't have to parse `docker compose
// port` output; 0 would also work but a fixed high port keeps the log
// output simpler to read.
const PUBLISHED_PORT = 18080

const composeEnv = {
  ...process.env,
  BLOCKBASE_IMAGE: IMAGE_TAG,
  BLOCKBASE_MCP_TOKEN: TOKEN,
  BIND_HOST: '127.0.0.1',
  PUBLISHED_PORT: String(PUBLISHED_PORT),
}

const cleanup = []
let failed = false

function step(label) {
  console.log(`\n=== ${label} ===`)
}

function ok(label) {
  console.log(`  ok: ${label}`)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', env: composeEnv, ...opts })
  if (result.error) throw result.error
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  }
  return result
}

function compose(args, opts = {}) {
  return run('docker', ['compose', '-f', 'compose.yaml', '-p', PROJECT_NAME, ...args], opts)
}

function composeQuiet(args) {
  return execFileSync('docker', ['compose', '-f', 'compose.yaml', '-p', PROJECT_NAME, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: composeEnv,
  }).trim()
}

function docker(args, opts = {}) {
  return run('docker', args, opts)
}

async function waitForHealthy(containerName, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const inspect = docker(['inspect', '--format', '{{json .State.Health.Status}}', containerName], { allowFail: true })
    const status = inspect.status === 0 ? inspect.stdout.trim().replace(/"/g, '') : undefined
    if (status === 'healthy') return
    if (status === 'unhealthy') {
      const log = docker(['inspect', '--format', '{{json .State.Health.Log}}', containerName], { allowFail: true })
      throw new Error(`container ${containerName} reported unhealthy: ${log.stdout}`)
    }
    if (Date.now() > deadline) throw new Error(`container ${containerName} did not become healthy within ${timeoutMs}ms (last status: ${status})`)
    await delay(500)
  }
}

async function main() {
  step('0. docker + compose reachable')
  docker(['info'])
  run('docker', ['compose', 'version'])
  ok('docker info and docker compose version succeeded')

  step('1. compose.yaml fails closed without BLOCKBASE_MCP_TOKEN')
  const missingToken = run('docker', ['compose', '-f', 'compose.yaml', '-p', PROJECT_NAME, 'config'], {
    allowFail: true,
    env: { ...process.env, BLOCKBASE_IMAGE: undefined, BLOCKBASE_MCP_TOKEN: undefined },
  })
  if (missingToken.status === 0) throw new Error('expected `docker compose config` to fail when BLOCKBASE_MCP_TOKEN is unset, but it succeeded')
  if (!/BLOCKBASE_MCP_TOKEN/.test(missingToken.stderr)) throw new Error(`expected a BLOCKBASE_MCP_TOKEN error, got: ${missingToken.stderr}`)
  ok('docker compose config refuses to resolve without a token, as expected')

  step('2. docker compose config resolves placeholders with a token set')
  const resolved = composeQuiet(['config'])
  if (!resolved.includes('host_ip: 127.0.0.1')) throw new Error(`expected default BIND_HOST 127.0.0.1 in resolved config, got:\n${resolved}`)
  if (resolved.includes(TOKEN) === false) throw new Error('resolved config did not include the runtime-supplied token (environment injection not wired correctly)')
  if (/100\.\d+\.\d+\.\d+/.test(resolved)) throw new Error('resolved config unexpectedly contains what looks like a real Tailscale address')
  ok('docker compose config resolves BIND_HOST/token from the environment, binds to loopback by default')

  step('3. build production image (reused by compose via BLOCKBASE_IMAGE)')
  docker(['build', '-t', IMAGE_TAG, '.'], { stdio: 'inherit' })
  cleanup.push(() => docker(['rmi', IMAGE_TAG], { allowFail: true }))
  ok(`built ${IMAGE_TAG}`)

  step('4. docker compose up -d')
  compose(['up', '-d'])
  cleanup.push(() => compose(['down', '--volumes'], { allowFail: true }))
  ok('compose service started')

  await waitForHealthy(CONTAINER_NAME, HEALTH_TIMEOUT_MS)
  ok('HEALTHCHECK reports healthy through compose (Dockerfile probe not overridden)')

  const baseUrl = `http://127.0.0.1:${PUBLISHED_PORT}/mcp`

  step('5. unauthenticated request proves "listening" without proving MCP access')
  const unauthedResponse = await fetch(baseUrl, { method: 'GET' })
  if (unauthedResponse.status !== 401) throw new Error(`expected 401 for unauthenticated GET ${baseUrl}, got ${unauthedResponse.status}`)
  const unauthedBody = await unauthedResponse.json()
  if (JSON.stringify(unauthedBody).includes(TOKEN)) throw new Error('unauthenticated response leaked the bearer token')
  ok(`unauthenticated request correctly rejected with 401 (${unauthedBody.error?.message ?? 'no message'})`)

  step('6. authenticated MCP initialize succeeds through the compose-published port')
  const initResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deployment-check', version: '0.0.0' } },
    }),
  })
  if (initResponse.status !== 200) throw new Error(`expected 200 from authenticated initialize, got ${initResponse.status}: ${await initResponse.text()}`)
  const initText = await initResponse.text()
  const initPayload = JSON.parse(initText.replace(/^event: message\ndata: /, '').trim())
  if (!initPayload.result?.serverInfo?.name) throw new Error(`initialize response missing serverInfo: ${initText}`)
  ok(`authenticated initialize succeeded (serverInfo.name=${initPayload.result.serverInfo.name}, protocolVersion=${initPayload.result.protocolVersion})`)

  step('7. write a catalog marker, then graceful restart (docker compose restart)')
  docker(['exec', CONTAINER_NAME, 'node', '-e', `require('fs').writeFileSync('/data/catalog/marker.txt', ${JSON.stringify(MARKER_VALUE)})`])
  compose(['restart'])
  await waitForHealthy(CONTAINER_NAME, HEALTH_TIMEOUT_MS)
  const survivedRestart = execFileSync('docker', ['exec', CONTAINER_NAME, 'cat', '/data/catalog/marker.txt'], { encoding: 'utf8' }).trim()
  if (survivedRestart !== MARKER_VALUE) throw new Error(`expected marker to survive \`docker compose restart\`, got "${survivedRestart}"`)
  ok('docker compose restart returned to healthy and the mounted catalog volume was untouched')

  step('8. docker compose down, then a fresh up against the same named volume (upgrade/rollback path)')
  compose(['down'])
  ok('docker compose down stopped and removed the container (volume kept — no --volumes here)')
  compose(['up', '-d'])
  await waitForHealthy(CONTAINER_NAME, HEALTH_TIMEOUT_MS)
  const survivedRecreate = execFileSync('docker', ['exec', CONTAINER_NAME, 'cat', '/data/catalog/marker.txt'], { encoding: 'utf8' }).trim()
  if (survivedRecreate !== MARKER_VALUE) throw new Error(`expected marker to survive down + up against the named volume, got "${survivedRecreate}"`)
  ok('marker survived docker compose down -> up against the same named volume (this is the upgrade/rollback story)')

  step('9. final teardown: docker compose down --volumes')
  compose(['down', '--volumes'])
  ok('docker compose down --volumes removed container, network, and the named volume')

  console.log('\nAll deployment-check checks passed.')
}

main()
  .catch((error) => {
    failed = true
    console.error(`\ndeployment-check FAILED: ${error.message}`)
  })
  .finally(() => {
    for (const fn of cleanup.reverse()) {
      try {
        fn()
      } catch {
        // best-effort teardown; never mask the original result
      }
    }
    process.exitCode = failed ? 1 : 0
  })
