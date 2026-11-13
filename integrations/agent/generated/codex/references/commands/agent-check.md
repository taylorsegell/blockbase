# `blockbase agent check`

Check that the umbrella skill, the focused skills, and the executable resolve to
this checkout. Missing, stale, or conflicting slots produce a non-zero exit,
structured status, and at most three bounded repair actions.

```sh
blockbase agent check --provider <claude-code|codex|cursor> --scope <project|global> [--project <path>] --json
blockbase agent check --home <isolated-agent-home> --json
```

The result includes `data.checks.mcp`, whose state is `disabled` for a
CLI-only installation, `enabled` for a valid Blockbase entry, `broken` for an
invalid or stale entry, or `present-unmanaged` for another server config.

It also reports `data.checks.catalog` (`present`, `missing`, or `legacy`) and
`data.checks.ui` (`running`, `installed`, or `absent`). These are read-only.
They count as issues only when the installation recorded that `agent install`
ran setup; then `blockbase setup --json` is the first repair action.
