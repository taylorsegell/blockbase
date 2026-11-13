# Contributing to Blockbase

Thanks for helping. Bug reports, fixes, and small focused features are all welcome. For anything larger, open an issue first so we can agree on the shape before you write it.

## Set up

You need Node.js 24 or newer and pnpm 12 (the version pinned in `packageManager`; `corepack enable` picks it up).

```sh
git clone https://github.com/taylorsegell/blockbase.git
cd blockbase
pnpm install
pnpm build
node packages/cli/dist/index.js doctor
```

Set `BLOCKBASE_HOME` to a scratch directory while you work so you don't touch your real catalog at `~/.blocks`.

## Before you open a pull request

Run the same gates CI runs:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm run drift:check
```

- **Agent skills are generated.** Edit the canonical spec in `integrations/agent/` (skills, `references/commands/`, `command-metadata.json`), then run `node integrations/agent/generate.mjs`. Don't edit `integrations/agent/generated/` by hand; `drift:check` fails if it disagrees with the spec. A change to CLI flags in `packages/cli/src/index.ts` also needs a regenerate.
- **The `--json` envelope is the public contract.** Changing its shape or an error code needs a contract update in `packages/contracts` and a note in the pull request.
- **Import never runs component code.** Keep it that way; see [SECURITY.md](SECURITY.md).
- Add or update tests next to the code you change (`packages/*/test/*.test.mjs`).

## Pull requests

Keep each pull request to one change, describe what it fixes and how you checked it, and make sure CI is green. Commit messages are plain sentences in the imperative ("Fix …", "Add …").

## Reporting security issues

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
