---
name: blockbase-organize
description: This skill should be used when the user asks to "tag this component", "remove a tag", "create a collection", "add this to favorites", "reorder a collection", "set the family", "change the category", "list catalog organization", or "migrate the legacy catalog", "undo that change", "roll back the catalog", "restore this component", or "show catalog history".
metadata:
  version: 0.3.2
---

# Blockbase organize

Propose an organization change, then apply it only after the user confirms.

Command contracts live at `../../references/commands/` relative to this skill directory.

Treat family as the manifest `category`. Leave an unknown family unchanged until the user agrees to create it. Include `--create` only for that agreement. Refuse `collection delete` for `favorites`.

1. Load the matching contract before the call: `tag-add.md`, `tag-remove.md`, `tag-list.md`, `collection-create.md`, `collection-add.md`, `collection-remove.md`, `collection-reorder.md`, `collection-delete.md`, `collection-list.md`, `family-set.md`, `family-list.md`, or `catalog-migrate.md` under `../../references/commands/`.
2. Read the current tags, collections, or families with the list command before proposing a change.
3. Show the exact command. Run it only after the user confirms.
4. Report the JSON result. Do not rename a slug, rewrite source, or edit `component.json` directly.

## Rolling back

Every catalog change (import, inbox, tags, collections, families) is one commit in the catalog's own history. When a change was wrong, roll it back with the CLI instead of editing files or running `git` in the catalog.

1. Load `history-list.md`, `history-undo.md`, or `history-restore.md`.
2. Run `blockbase history list [component] --json` and show the user the entries you would undo or restore to.
3. For the last change or the last few, propose `blockbase history undo [--steps <n>] --json`. For one component, propose `blockbase history restore <component> --to <commit> --json`.
4. Run it only after the user confirms, then report the JSON result. A rollback is itself undoable.

If the operation is absent from the installed registry, report it as unavailable.
