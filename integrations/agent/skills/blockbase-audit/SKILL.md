---
name: blockbase-audit
description: This skill should be used when the user asks to "audit Blockbase", "run doctor", "check catalog health", "validate the catalog", "find remote assets", "show unresolved dependencies", or "find a leftover demo".
metadata:
  version: 0.3.2
---

# Blockbase audit

Report problems. Do not rewrite a component, its revision, or the catalog.

Command contracts live at `${CLAUDE_PLUGIN_ROOT}/references/commands/`. When that variable is unset, use `../../references/commands/` from this skill directory.

Load a contract only for the question the user asked.

1. For one named component, load `${CLAUDE_PLUGIN_ROOT}/references/commands/inspect.md` and run `blockbase inspect <id> --json`. Report `quality.parseStatus`, `quality.previewStatus`, `quality.riskLevel`, `quality.warnings`, and `dependencies`.
2. When the user asks about catalog health, load `${CLAUDE_PLUGIN_ROOT}/references/commands/doctor.md` and `${CLAUDE_PLUGIN_ROOT}/references/commands/catalog-validate.md`. Run `blockbase doctor --json` and `blockbase catalog validate --json`.
3. When the user asks which categories are missing, load `${CLAUDE_PLUGIN_ROOT}/references/commands/family-list.md`, run `blockbase family list --json`, and report the `unassigned` entries. Leave `taxonomy.json` unread.
4. When the user asks to audit the whole catalog, load `${CLAUDE_PLUGIN_ROOT}/references/commands/tag-list.md` and run `blockbase tag list --json` to enumerate, then inspect each component.
5. When the user asks about a leftover demo or a remote asset, run `blockbase inspect <id> --json` and report the `quality.warnings` entries that start with `demo-file:` (a leftover demo file) or `remote-url:` (a remote asset), each followed by its relative path. Leave revision files unread and do not edit them.
6. Summarize each finding with the component id and the command that produced it.

If `inspect`, `doctor`, or `catalog validate` is absent from the installed registry, report the audit as unavailable.
