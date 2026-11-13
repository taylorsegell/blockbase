# Blockbase v1 release readiness

This checklist records release evidence for the approved v1 scope: the
repository-owned catalog, CLI, MCP server, provider packages, constrained
preview, themes, metadata, adapters, and supported handoff fixtures.

| Gate | Command/evidence | Status |
| --- | --- | --- |
| Scale benchmark | `pnpm run benchmark` | Requires exact ID median `< 50 ms` and typical text median `< 200 ms` at 10,000 entries. |
| Source/destination matrix | `pnpm run regression:matrix` | Records first-pass success, residual-literal rate, false semantic mappings, destination build pass, and median exchanges. |
| Clean installation | `.github/workflows/clean-install.yml` | macOS/Linux frozen-lockfile install, isolated plugin install/check, build, and test gates. |
| Generated drift | `pnpm run drift:check` | Provider, projection, and theme artifacts are checked against canonical sources. |
| Full regression | `pnpm test` | CLI, skills, MCP, preview-security, and supported handoff fixtures. |

## Explicit boundaries

The following remain unverified and must not be claimed in release notes:

- Windows installation or Windows filesystem behavior.
- Sandboxed deployment beyond constrained preview-policy tests.
- Live Cursor, Claude Code, or Codex model playback; matrix counts are deterministic fixture exchanges.
- Browser playback, viewport rendering, and live visual regression.
- Deferred frameworks or adapters outside the supported React handoff subset.
- Vector search, cloud services, hosted installation, and arbitrary code execution.
- Live npm registry publication of the five `@blockbase/*` packages and live Claude Code marketplace installation. `pnpm run pack:smoke` and `pnpm run release:dry` exercise the tarballs offline, and the root `.claude-plugin/marketplace.json` and generated plugin pass `claude plugin validate`, but no release has been published or installed from the real registry or marketplace.

Record CI URLs and attach generated benchmark/matrix reports to the release
review. A release is not ready when a required gate fails or an unverified
boundary is presented as verified evidence.
