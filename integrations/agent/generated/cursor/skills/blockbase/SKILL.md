---
name: blockbase
description: This skill should be used when the user asks to "import this component into Blockbase", "park this paste", "find a Blockbase component", "adapt this block to my project", "organize the catalog", "audit Blockbase", or "link the Blockbase agent". It routes that request to the matching focused Blockbase skill and the blockbase CLI.
metadata:
  version: 0.3.2
---

# Blockbase

Call the `blockbase` executable for every catalog operation. Acquire context, choose the focused workflow, call the advertised CLI operation, and present its JSON result. Treat the CLI as authoritative for command names, JSON envelopes, diagnostics, and exit codes. Leave parsing, normalization, token mapping, and validation to the CLI.

Command contracts live at `../../references/commands/` relative to this skill directory.

## Routing

- Import a local file, folder, stdin paste, or 21st.dev paste now: use `blockbase-capture`.
- Park a paste (including a 21st.dev paste) or path for a later import, or list, show, import, or discard a parked item: use `blockbase-inbox`.
- Find a catalog component and adapt it into a destination project: use `blockbase-find-and-fit`.
- Tags, collections, families, categories, or a legacy catalog migration: use `blockbase-organize`.
- Audit quality, catalog health, remote assets, dependencies, or a leftover demo: use `blockbase-audit`.
- Undo or roll back a catalog change, or see what changed: use `blockbase-organize`.
- Check the local installation: run `blockbase agent check --provider <host> --scope <scope> [--project <dir>] --json`. If `checks.catalog` is `missing` or `checks.ui` is `absent`, show `blockbase setup --json`, say it installs a user login service that serves the catalog page, and run it after the user confirms.
- Review one operation contract, then call that JSON CLI operation.

## Finding the binary

Use `blockbase` on `PATH`. The Claude Code plugin provides it automatically while the plugin is enabled. Otherwise use `../../bin/blockbase` relative to this skill directory.

## First run

If session context says the catalog or the catalog page is not set up, offer `blockbase setup --json` on the user's first Blockbase request. It creates `~/.blocks` and a login service that serves `http://127.0.0.1:47821/#home`. Run it only after the user agrees.

As a last resort for a checkout, `blockbase agent link --home <agent-home>` links the skills and the executable into an agent home.
