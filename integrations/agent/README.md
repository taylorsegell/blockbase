# Blockbase provider packages

The files at this directory's root are the canonical agent integration source:

- `SKILL.md` is the umbrella router.
- `skills/*/SKILL.md` contains the focused workflows: capture, inbox, find-and-fit, organize, and audit.
- `plugin.json` is the Claude Code plugin manifest. The generator copies it to `generated/claude-code/.claude-plugin/plugin.json`.
- `references/commands/*.md` is loaded per CLI operation.
- `providers/*.yaml` declares the three provider package targets.
- `command-metadata.json` is generated from the live CLI registry and is not a
  second command authority.

`generate.mjs` produces the provider packages under `generated/<provider>/`.
Each package contains the same canonical skills, operation references, and
registry metadata, plus a deterministic manifest identifying its provider and
source hash. Provider descriptors change package placement metadata only; they
do not add workflow or transformation logic.

Regenerate after changing a canonical source:

```sh
node integrations/agent/generate.mjs
node integrations/agent/generate.mjs --check
node --test integrations/agent/provider-packages.test.mjs
```

The generator rejects missing CLI operation hints or hints for options absent
from the live parser. It writes only repository-relative paths and never embeds
secrets, timestamps, or checkout-specific paths.

## Install

Claude Code (nothing else is needed; the plugin installs the CLI and puts `blockbase` on `PATH`):

```sh
/plugin marketplace add taylorsegell/blockbase
/plugin install blockbase@blockbase
```

The repository root `.claude-plugin/marketplace.json` points at `integrations/agent/generated/claude-code`. For a local checkout use `/plugin marketplace add ./` from the repository root. The older `integrations/agent/.claude-plugin/marketplace.json` was removed; it duplicated the root manifest.

Cursor and Codex:

```sh
npm install -g @blockbase/cli
blockbase agent install --provider cursor --scope project --project <dir>
blockbase agent install --provider codex --scope project --project <dir>
```

`agent install` also runs `blockbase setup`, which creates the catalog and installs the catalog page login service; pass `--no-setup` to skip it.

Before uninstalling the Claude Code plugin run `blockbase ui service uninstall`, because without a global `blockbase` the login service runs the CLI from the plugin data directory, which is deleted with the plugin.

## Claude Code runtime files

`runtime/` holds files emitted only into `generated/claude-code`: `bin/blockbase` (launcher), `hooks/hooks.json`, and `hooks/session-start.sh` (installs `@blockbase/cli` into `${CLAUDE_PLUGIN_DATA}/cli`, writes `BLOCKBASE_CLI_ENTRY` to `CLAUDE_ENV_FILE`, and prints a setup hint when needed). Set `BLOCKBASE_CLI_SPEC` to override the install spec, for example a local tarball.
