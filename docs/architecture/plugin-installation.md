# Blockbase plugin installation

The repository is the canonical Blockbase agent bundle. `blockbase agent`
lifecycle operations are local and do not publish a package, download a binary,
or copy an absolute checkout path into canonical source files. (The Claude Code
plugin's SessionStart hook is the one path that downloads: it runs `npm install`
for `@blockbase/cli`.) The one persistent process is the
opt-out, user-level login service that serves the catalog page (see
[Setup and the catalog page](#setup-and-the-catalog-page)).

Claude Code, Codex, and Cursor support both project and global scopes. Project
installs use `.claude`, `.codex`, or `.cursor` below the project root; global
installs use the same directory below the agent home. `--home` is an explicit
isolated agent-home override, useful in tests. MCP is optional and reported as
`disabled` when no provider-owned configuration is present.

| Provider | Project root | Global root | Scopes | MCP state |
| --- | --- | --- | --- | --- |
| Claude Code | `<project>/.claude` | `<home>/.claude` | project, global | optional / `disabled` unless a config is present |
| Codex | `<project>/.codex` | `<home>/.codex` | project, global | optional / `disabled` unless a config is present |
| Cursor | `<project>/.cursor` | `<home>/.cursor` | project, global | optional / `disabled` unless a config is present |

The isolated lifecycle transcript exercised by `packages/cli/test/plugin.test.mjs`
is: install → check → mutate an owned payload → check stale → update → check
healthy → remove, plus the same project-scope link/check/repair/remove flow for
each provider. The test also creates a user-owned skill and asserts it survives
update and removal.

## Documented install

From npm (no clone; the `@blockbase/cli` package carries the generated provider packages under `payload/` and depends on `@blockbase/preview` for the catalog page):

```sh
npm install -g @blockbase/cli
blockbase agent install --provider <claude-code|codex|cursor> --scope project --project <dir>
```

As a Claude Code plugin, from the repository root marketplace (`.claude-plugin/marketplace.json`, source `./integrations/agent/generated/claude-code`):

```sh
/plugin marketplace add taylorsegell/blockbase
/plugin install blockbase@blockbase
```

The plugin's SessionStart hook (`hooks/session-start.sh`) installs `@blockbase/cli` at the plugin version into `${CLAUDE_PLUGIN_DATA}/cli` unless another `blockbase` is on `PATH`, and the plugin's `bin/blockbase` launcher resolves the CLI for the Bash tool. The hook never fails the session; it prints a setup hint only when the catalog or the page is missing.

From source:

```sh
git clone <this-repository> && cd blockbase
pnpm install
pnpm build
pnpm add --global "$PWD/packages/cli"   # puts `blockbase` on PATH; run `pnpm setup` once first if pnpm has no global bin directory
blockbase agent install --provider <claude-code|codex|cursor> --scope project --project <dir>
```

The final command installs the provider package, then runs `blockbase setup`,
which creates `~/.blocks` and starts the catalog page at
`http://127.0.0.1:47821/#home`. Project scope requires `--project`; without it
the command fails with `AGENT_PROJECT_REQUIRED` and writes nothing.

## Install and update

`install` copies the generated provider package and creates a `bin/blockbase`
symlink to the running CLI's `dist/index.js` (the checkout or the installed package). It writes `.blockbase-install.json` as the ownership
inventory. Existing files not listed in that inventory are conflicts and are
never overwritten.

```sh
AGENT_HOME="$(mktemp -d)"
node packages/cli/dist/index.js agent install --provider codex --scope global --home "$AGENT_HOME" --json
node packages/cli/dist/index.js agent check --provider codex --scope global --home "$AGENT_HOME" --json
node packages/cli/dist/index.js agent update --provider codex --scope global --home "$AGENT_HOME" --json
```

`check` reports missing CLI, stale generated payload, broken links,
incompatible package versions, and MCP state. Its repair actions are bounded
to relinking or refreshing the owned provider payload.

`install` and `update` also run setup after the inventory is written, unless
`--no-setup` is passed, `--home` is given, or the `CI` environment variable is
set. The outcome is recorded in `.blockbase-install.json` as
`setup: {ran, catalog, service, url}`. A setup problem is reported in the
result (`setup` and `setupError`) and never fails the install. `check` also
reports `checks.catalog` (`present`, `missing`, `legacy`) and `checks.ui`
(`running`, `installed`, `absent`) read-only; they become issues only when the
inventory records `setup.ran: true`, and then `blockbase setup --json` is the
first repair action.

## Setup and the catalog page

`blockbase setup --json` is idempotent. The catalog root is `--catalog`, then
`BLOCKBASE_HOME`, then `~/.blocks`.

| State of the root | Result |
| --- | --- |
| Contains `index.sqlite` | `catalog: present`, untouched |
| Contains `catalog.yaml` | `catalog: legacy`, issue `catalog-legacy` with repair `blockbase catalog migrate --json`, untouched, no service |
| Absent, empty, or holding only `.DS_Store`, `components/`, `inbox/`, `index.sqlite*` | `components/` and an empty index are created: `catalog: created` |
| Holds anything else | `SETUP_CATALOG_CONFLICT`, exit 5, nothing written |

Unless `--no-service` is passed, setup then installs the login service, starts
it, and polls `/api/health` for up to about 15 seconds. The page counts as
healthy only when `/api/health` answers 200 with `application/json` and a body
that names `catalogRoot`; a bare 200 is the dev server's single-page fallback.
`service` is `installed`, `refreshed`, `running`, `skipped`, or `failed`, and
`issues` lists any problem with a repair command.

`blockbase ui` serves the page in the foreground (`--port`, default 47821;
`--allowed-host`, repeatable; `--open`). It loads the preview server from the
checkout's `apps/preview/dist/server/index.js` and fails with
`PREVIEW_NOT_BUILT` when the workspace has not been built. The server binds
`127.0.0.1` only; there is no tailnet or cloud profile. `blockbase ui status
--json` probes the health endpoint and returns `{running, url, catalogRoot?,
count?, service}`.

## Login service and ownership

`blockbase ui service install | uninstall | status` manage one definition:

| Platform | Definition | Loaded with |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.blockbase.ui.plist` (logs in `~/Library/Logs/blockbase-ui*.log`) | `launchctl bootout` then `launchctl bootstrap gui/<uid>` |
| Linux | `~/.config/systemd/user/blockbase-ui.service` | `systemctl --user daemon-reload` and `enable --now` |
| Other | not supported | `SERVICE_UNSUPPORTED`, exit 6 |

The definition runs the absolute Node binary that installed it. A Homebrew
install is recorded through the stable `<prefix>/opt/node` symlink (for example
`/opt/homebrew/opt/node/bin/node`) rather than the versioned `Cellar` path, so a
`brew upgrade node` keeps working. Version-pinned paths such as nvm's
`~/.nvm/versions/node/<version>/bin/node` still move on upgrade and can leave
the definition pointing at a missing binary; `service status` warns and
`service install` refreshes it.

On macOS a refresh runs `bootout`, waits until `launchctl print` exits 113
("not found", any other answer keeps polling), then runs `bootstrap`, retrying a
failed bootstrap with backoff. If the new definition still cannot be loaded, the
previous definition file and inventory are put back and the previous service is
started again. The failure reports the two facts separately in its details:
`restored` (the files are back) and `running` (the manager reports the service
loaded). When `running` is false the message says the service is stopped and the
failure carries a recovery action to run `blockbase ui service install`.
`setup`, `agent install` and `agent update` pass that failure on as an `issues`
entry with the same repair command, and `setup` reports the port still recorded
in the inventory. A failed definition or inventory write is rolled back the same
way; on a fresh install the definition file is removed so nothing unowned stays
behind. The deadlines of the whole failed-refresh path add up to 10 seconds (8
for the new definition, 2 for the restore), well inside the 15 seconds the
VS Code extension allows for `blockbase ui status`. Each phase keeps a reserve so
at least one bootstrap attempt runs even when `launchctl print` hangs, and each
service-manager call is cut off after 5 seconds with SIGKILL.

Ownership is recorded in `<catalog>/.blockbase-service.json`
(`schemaVersion`, `platform`, `path`, `sha256`, `label`, `port`, `installedAt`):

- Install never overwrites a definition that is not in the inventory, or whose
  hash differs from the recorded one (`SERVICE_CONFLICT`, exit 5).
- Install of identical content is a no-op (`present`) that still ensures the
  service is loaded; a changed port or host list is a `refreshed` rewrite.
- Uninstall boots the service out, deletes only the recorded path, and deletes
  the inventory. It refuses to delete a definition edited after install.
- `agent remove` never uninstalls the service. When the inventory says setup
  ran, it prints the hint `blockbase ui service uninstall --json`.

Tests set `BLOCKBASE_SERVICE_RUNNER` to an executable that stands in for
`launchctl`/`systemctl`, and `HOME` to a temporary directory. They also set
`BLOCKBASE_SERVICE_WAIT_MS` (the base wait unit for teardown polling and
bootstrap backoff, 250 by default) to a few milliseconds so the waits stay
short, and tests that hang the runner on purpose set
`BLOCKBASE_SERVICE_BUDGET_SCALE` (a number between 0 and 1) to shrink every
deadline, reserve and per-call timeout in the same proportion.

## Link and check

Build the workspace, then choose an agent home. An isolated home is useful for
smoke tests:

```sh
pnpm build
AGENT_HOME="$(mktemp -d)"
node packages/cli/dist/index.js agent link --home "$AGENT_HOME" --json
node packages/cli/dist/index.js agent check --home "$AGENT_HOME" --json
```

The generic link command creates symlinks for the umbrella `blockbase` skill, the focused skills (`blockbase-capture`, `blockbase-inbox`, `blockbase-find-and-fit`, `blockbase-organize`, and `blockbase-audit`), and the
checkout's `blockbase` executable under `<agent-home>/bin`. Existing correct
links are reused, stale symlinks are repaired, and regular files are preserved
and reported as conflicts.

## Unlink and repair

```sh
node packages/cli/dist/index.js agent unlink --home "$AGENT_HOME" --json
node packages/cli/dist/index.js agent unlink --home "$AGENT_HOME" --json
node packages/cli/dist/index.js agent link --home "$AGENT_HOME" --json
```

Unlink is idempotent. Check reports a bounded repair plan for missing, stale,
or conflicting slots; it does not remove regular files or mutate plugin source.

Provider-scoped local linking is also available:

```sh
node packages/cli/dist/index.js agent link --provider cursor --scope project --project /path/to/project --json
```

## Removal and ownership

```sh
node packages/cli/dist/index.js agent remove --provider codex --scope global --home "$AGENT_HOME" --json
```

Removal consults the ownership inventory and deletes only Blockbase-owned
payload files, links, and the inventory itself. Catalog data and unrelated
skills/configuration are outside the inventory and are preserved.

## Contract boundary

`integrations/agent/command-metadata.json` is checked against the CLI operation
registry during tests. Focused skill files orchestrate and route only; parsing,
normalization, mapping, and validation remain in the CLI/core packages.

## Clean-install release gate

The supported clean-install gate runs on macOS and Linux with Node 24 and
pnpm 12.3.4. It installs from the committed lockfile, builds the CLI, creates
an isolated provider home, installs (`--no-setup`) and checks the Codex package,
runs `blockbase setup --no-service --json` against a temporary `BLOCKBASE_HOME`
and asserts `catalog: "created"`, then runs `doctor --json` and the
CLI, MCP, preview-security, supported handoff, projection, theme, and provider
drift suites. Run the same checks locally with `pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm test`, `pnpm run drift:check`, `pnpm run regression:matrix`,
and `pnpm run benchmark`.

The workflow does not claim Windows, live agent/model sessions, or sandboxed
deployment behavior. It never installs a real login service.
