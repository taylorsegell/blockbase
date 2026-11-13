---
name: blockbase-inbox
description: This skill should be used when the user asks to "park this component", "hold this paste", "add this to the Blockbase inbox", "stage this path for later", "list parked items", "show this inbox item", "import this parked item", or "discard this inbox item".
metadata:
  version: 0.3.2
---

# Blockbase inbox

Park source bytes without parsing them. The one exception is a 21st.dev paste parked with `--from 21st`: it is checked once when it is added, so a paste with no code or no component is refused, and the raw paste is kept untouched. Run only the branch the user asked for.

Command contracts live at `${CLAUDE_PLUGIN_ROOT}/references/commands/`. When that variable is unset, use `../../references/commands/` from this skill directory.

Treat `inbox import` and `inbox discard` as writes. Run each one after the user confirms the exact command.

## Park

Load `${CLAUDE_PLUGIN_ROOT}/references/commands/inbox-add.md`. Call `blockbase inbox add --json` with only the options that file documents. Leave the bytes unchanged. For a 21st.dev paste, pass `--from 21st` with stdin (`-`). Report the inbox id, and say when the item shows `from: '21st'`.

## List or show

Load `${CLAUDE_PLUGIN_ROOT}/references/commands/inbox-list.md` or `${CLAUDE_PLUGIN_ROOT}/references/commands/inbox-show.md`. Report id, kind, label, payload path, and `from` when it is present. Print payload bytes only when the user asks.

## Import a parked item

Show `blockbase inbox import <id> --json` plus any `--namespace`, `--slug`, `--name`, `--entry-point`, or provenance options (`--source-type`, `--source-url`, `--license`, `--author`, `--tag`) the user supplied. After confirmation, load `${CLAUDE_PLUGIN_ROOT}/references/commands/inbox-import.md`, run it, and report the component id and whether the inbox item was discarded. For a 21st.dev paste, also report the `paste` and `demo` warnings, suspicions, and demo rewrites from the result. Then run `blockbase ui status --json`; when `data.running` is true, report the component id together with `data.url`. Do not start the server from this skill.

## Discard

After confirmation, load `${CLAUDE_PLUGIN_ROOT}/references/commands/inbox-discard.md` and call `blockbase inbox discard <id> --json`.

If an inbox operation is absent from the installed registry, report the workflow as unavailable. Do not copy files into the catalog by hand.
