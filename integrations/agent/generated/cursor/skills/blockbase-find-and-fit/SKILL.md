---
name: blockbase-find-and-fit
description: This skill should be used when the user asks to "find a component for this project", "adapt this block", "add this Blockbase component to my app", or "fit this component to the destination". It searches the catalog and prepares a destination handoff through the blockbase CLI.
metadata:
  version: 0.3.2
---

# Blockbase find and fit

Locate a catalog component and hand it to a destination project. Do not invent a component.

Command contracts live at `../../references/commands/` relative to this skill directory.

1. Load `../../references/commands/project-inspect.md` and call `blockbase project inspect --cwd <path> --json` for the destination context this handoff needs.
2. Load `../../references/commands/search.md` and call `blockbase search <query> --project <path> --json`. Ask the user when the result is ambiguous.
3. Load `../../references/commands/adapt.md` and call `blockbase adapt <component-id> --project <path> --json`. This stages a handoff and does not write the destination.
4. After the user approves the proposed files, load `../../references/commands/add.md` and call `blockbase add <component-id> --project <path> --apply --json`.
5. Load `../../references/commands/validate.md`, run the checks the adaptation manifest declares, and report the residuals.

If a required operation is absent from the installed registry, report the handoff as unavailable. Report the CLI JSON. Do not write a second importer.
