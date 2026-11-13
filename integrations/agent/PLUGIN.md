# Blockbase

Agent skills for the local Blockbase catalog. Skills call the `blockbase` CLI. They do not parse components or write the catalog themselves.

## Install in Claude Code

```sh
/plugin marketplace add taylorsegell/blockbase
/plugin install blockbase@blockbase
```

Nothing else is needed. The plugin puts `blockbase` on the Bash tool's `PATH` and installs `@blockbase/cli` into the plugin data directory on the next session (Node.js 24 or newer and npm are required). The first Blockbase request offers to run `blockbase setup`, which creates `~/.blocks` and a login service for the catalog page at `http://127.0.0.1:47821/#home`. Claude asks before running it.

If the automatic install fails, run `npm install -g @blockbase/cli` and restart Claude Code.

## Uninstall

Unless a global `blockbase` was installed, the login service runs the CLI from the plugin data directory, which Claude Code deletes with the plugin. Remove the service first:

```sh
blockbase ui service uninstall
```

Then uninstall the plugin with `/plugin uninstall blockbase@blockbase`.

## Cursor and Codex

```sh
npm install -g @blockbase/cli
blockbase agent install --provider cursor --scope project --project <dir>
blockbase agent install --provider codex --scope project --project <dir>
```

`agent install` also runs `blockbase setup`; pass `--no-setup` to skip it.
