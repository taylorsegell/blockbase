#!/usr/bin/env node
// Repeatable smoke check for the Blockbase MCP production container
// (see root Dockerfile). Builds the image, then proves - against a real
// running container, not a mock - every claim the packaging task needs
// evidence for:
//
//   1. the Node runtime inside the container is 24.x
//   2. the container starts and the HTTP MCP server comes up
//   3. an unauthenticated request is visibly distinct from an authenticated
//      one (readiness vs. real MCP access, per M2's bearer-token boundary)
//   4. a real authenticated MCP `initialize` call succeeds over that
//      boundary
//   5. data written to the mounted catalog volume survives the container
//      being stopped, removed, and replaced by a fresh one from the same
//      image + volume
//   6. SIGTERM (docker stop) produces a clean, fast exit - not a timeout
//      fallback to SIGKILL
//
// Usage: node scripts/container-smoke.mjs   (also: pnpm run container:smoke)
// Requires a working Docker daemon. Exits non-zero with a clear message at
// the first failing step; always tears down the containers/volume it made.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// fileURLToPath (not the raw .pathname) so a repo path containing spaces or
// other percent-encoded characters resolves to a real, usable cwd.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const IMAGE_TAG = 'blockbase-mcp:smoke'
const RUN_ID = randomUUID().slice(0, 8)
const CONTAINER_A = `blockbase-smoke-${RUN_ID}-a`
const CONTAINER_B = `blockbase-smoke-${RUN_ID}-b`
const VOLUME_NAME = `blockbase-smoke-${RUN_ID}-catalog`
// Clearly-fake token: never a real secret, matches this repo's convention
// for test fixtures (see packages/mcp/test/http-server.test.mjs).
const TOKEN = `container-smoke-${RUN_ID}-not-a-real-secret`
const MARKER_VALUE = `round-trip-${RUN_ID}-${Date.now()}`
const STOP_GRACE_SECONDS = 10
const HEALTH_TIMEOUT_MS = 30_000

const cleanup = []
let failed = false

function step(label) {
  console.log(`\n=== ${label} ===`)
}

function ok(label) {
  console.log(`  ok: ${label}`)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts })
  if (result.error) throw result.error
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  }
  return result
}

function docker(args, opts = {}) {
  return run('docker', args, opts)
}

function dockerQuiet(args) {
  return execFileSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
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
  step('0. docker daemon reachable')
  docker(['info'])
  ok('docker info succeeded')

  step('1. build production image')
  docker(['build', '-t', IMAGE_TAG, '.'], { stdio: 'inherit' })
  ok(`built ${IMAGE_TAG}`)

  step('2. Node version inside the image is 24.x')
  const nodeVersion = dockerQuiet(['run', '--rm', IMAGE_TAG, 'node', '--version'])
  console.log(`  node --version -> ${nodeVersion}`)
  if (!/^v24\./.test(nodeVersion)) throw new Error(`expected Node 24.x inside the container, got ${nodeVersion}`)
  ok('Node 24.x confirmed')

  step('2b. runtime user is non-root')
  const whoami = dockerQuiet(['run', '--rm', IMAGE_TAG, 'whoami'])
  if (whoami === 'root') throw new Error('container runs as root; expected a non-root user')
  ok(`runs as non-root user "${whoami}"`)

  step('3. start container A with a named volume + real bearer token')
  docker(['volume', 'create', VOLUME_NAME])
  cleanup.push(() => docker(['volume', 'rm', VOLUME_NAME], { allowFail: true }))
  docker([
    'run', '-d', '--name', CONTAINER_A,
    '-e', `BLOCKBASE_MCP_TOKEN=${TOKEN}`,
    '-v', `${VOLUME_NAME}:/data/catalog`,
    '-p', '0:8080',
    IMAGE_TAG,
  ])
  cleanup.push(() => docker(['rm', '-f', CONTAINER_A], { allowFail: true }))
  ok(`container ${CONTAINER_A} started`)

  await waitForHealthy(CONTAINER_A, HEALTH_TIMEOUT_MS)
  ok('HEALTHCHECK reports healthy (process listening, no token required for this probe)')

  const portMap = dockerQuiet(['port', CONTAINER_A, '8080/tcp'])
  const hostPort = portMap.split(':').pop().trim()
  const baseUrl = `http://127.0.0.1:${hostPort}/mcp`

  step('4. unauthenticated request proves "listening" without proving MCP access')
  const unauthedResponse = await fetch(baseUrl, { method: 'GET' })
  if (unauthedResponse.status !== 401) throw new Error(`expected 401 for unauthenticated GET ${baseUrl}, got ${unauthedResponse.status}`)
  const unauthedBody = await unauthedResponse.json()
  if (JSON.stringify(unauthedBody).includes(TOKEN)) throw new Error('unauthenticated response leaked the bearer token')
  ok(`unauthenticated request correctly rejected with 401 (${unauthedBody.error?.message ?? 'no message'})`)

  step('5. authenticated MCP initialize succeeds over the real bearer-token boundary')
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
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'container-smoke', version: '0.0.0' } },
    }),
  })
  if (initResponse.status !== 200) throw new Error(`expected 200 from authenticated initialize, got ${initResponse.status}: ${await initResponse.text()}`)
  const initText = await initResponse.text()
  const initPayload = JSON.parse(initText.replace(/^event: message\ndata: /, '').trim())
  if (!initPayload.result?.serverInfo?.name) throw new Error(`initialize response missing serverInfo: ${initText}`)
  ok(`authenticated initialize succeeded (serverInfo.name=${initPayload.result.serverInfo.name}, protocolVersion=${initPayload.result.protocolVersion})`)

  step('6. volume round-trip: write via container A, survive stop+rm+replace')
  docker(['exec', CONTAINER_A, 'node', '-e', `require('fs').writeFileSync('/data/catalog/marker.txt', ${JSON.stringify(MARKER_VALUE)})`])
  const writtenBack = dockerQuiet(['exec', CONTAINER_A, 'cat', '/data/catalog/marker.txt'])
  if (writtenBack !== MARKER_VALUE) throw new Error(`marker readback mismatch immediately after write: ${writtenBack}`)
  ok('marker written to /data/catalog inside container A')

  step('7. graceful stop (SIGTERM) of container A')
  const stopStart = Date.now()
  docker(['stop', '--time', String(STOP_GRACE_SECONDS), CONTAINER_A])
  const stopElapsedMs = Date.now() - stopStart
  const exitCode = dockerQuiet(['inspect', '--format', '{{.State.ExitCode}}', CONTAINER_A])
  if (exitCode !== '0') throw new Error(`container A exited ${exitCode} after SIGTERM (expected 0 for a clean shutdown)`)
  if (stopElapsedMs >= STOP_GRACE_SECONDS * 1000) {
    throw new Error(`container A took >= ${STOP_GRACE_SECONDS}s to stop; SIGTERM handling likely fell through to SIGKILL`)
  }
  ok(`container A exited 0 in ${stopElapsedMs}ms (well under the ${STOP_GRACE_SECONDS}s SIGKILL grace period)`)
  docker(['rm', CONTAINER_A])
  ok('container A removed')

  step('8. start container B from the same image + volume, confirm the marker survived')
  docker([
    'run', '-d', '--name', CONTAINER_B,
    '-e', `BLOCKBASE_MCP_TOKEN=${TOKEN}`,
    '-v', `${VOLUME_NAME}:/data/catalog`,
    '-p', '0:8080',
    IMAGE_TAG,
  ])
  cleanup.push(() => docker(['rm', '-f', CONTAINER_B], { allowFail: true }))
  await waitForHealthy(CONTAINER_B, HEALTH_TIMEOUT_MS)
  const survived = dockerQuiet(['exec', CONTAINER_B, 'cat', '/data/catalog/marker.txt'])
  if (survived !== MARKER_VALUE) throw new Error(`expected marker "${MARKER_VALUE}" to survive container replacement, got "${survived}"`)
  ok('marker survived stop -> rm -> fresh container from the same volume')

  step('9. graceful stop of container B (final teardown)')
  docker(['stop', '--time', String(STOP_GRACE_SECONDS), CONTAINER_B])
  docker(['rm', CONTAINER_B])
  ok('container B stopped and removed')

  console.log('\nAll container-smoke checks passed.')
}

main()
  .catch((error) => {
    failed = true
    console.error(`\ncontainer-smoke FAILED: ${error.message}`)
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
