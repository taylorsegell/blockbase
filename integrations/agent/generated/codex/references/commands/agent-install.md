# `blockbase agent install`

Install one generated provider package into an isolated, project, or global
agent scope. The command records `.blockbase-install.json` and refuses to
overwrite paths that are not owned by that inventory.

```sh
blockbase agent install --provider <claude-code|codex|cursor> --scope <project|global> [--project <path>] [--home <path>] [--mcp] [--no-setup] --json
```

By default the install then runs `blockbase setup`: it creates `~/.blocks` (or
`BLOCKBASE_HOME`) when absent and installs the user login service that serves
the catalog page, and the inventory records the outcome. Setup is skipped with
`--no-setup`, with `--home`, or when `CI` is set. A setup problem is reported in
the result and does not fail the install. `agent remove` leaves the service in
place and prints `blockbase ui service uninstall --json` as a hint.

MCP is optional. Passing `--mcp` adds a Blockbase stdio server entry to the
provider's `mcp.json` only when that file is absent; an existing unmanaged or
broken file is never overwritten.
