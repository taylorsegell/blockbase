---
name: blockbase-capture
description: This skill should be used when the user asks to "import this component", "add this file to Blockbase", "capture this folder", "import this package", "import this 21st.dev paste", or "add this 21st.dev component". It imports a local file, directory, stdin paste, or 21st.dev paste through the blockbase CLI.
metadata:
  version: 0.3.2
---

# Blockbase capture

Import a local component now. Leave the source bytes unchanged.

Command contracts live at `../../references/commands/` relative to this skill directory.

1. Keep the user's source boundary. A file, a directory, and stdin are different sources.
2. Load `../../references/commands/import.md`.
3. Decide whether the source is a 21st.dev paste (see below). If it is, follow the 21st.dev steps. Otherwise call `blockbase import <source> --json` with only the documented options. Do not rewrite the source or invent metadata.
4. Report the JSON result, residuals, and warnings.
5. Load `../../references/commands/catalog-validate.md` and call `blockbase catalog validate --json` after a successful import.
6. Run `blockbase ui status --json`. When `data.running` is true, report the component id together with `data.url`. Do not start the server from this skill.

## Recognizing a 21st.dev paste

Treat pasted text as a 21st.dev paste when any of these is true. Do not ask the user to choose a mode.

- The user says it came from 21st.dev.
- A fenced block where a line holding only a file name starts each file.
- `// --- Component ---` style marker lines.
- An "Install NPM dependencies" block.
- Imports from `@/components/ui/`.
- A "Built using" comment.

## 21st.dev steps

1. Ask for anything the paste does not hold. When the paste has no file names, ask for a component name first. Ask for the page URL and the license. When the user gives no license, record `unknown`; never guess one. When the paste names an author, confirm it with the user.
2. Pipe the paste to `blockbase import - --from 21st --json`, adding `--name`, `--source-url`, `--license`, `--author`, and `--tag` only as the user gave them.
3. Messy pastes still import. Blockbase looks past invisible characters, stray spaces, odd fences, loose markers, decorated file names and a missing closing fence when it finds where each file starts and ends, and it never changes the code inside a file. Read `paste.normalizations` for what it tidied and `paste.suspicions` (also listed as `paste-suspect:<file>:<reason>` warnings) for what looks wrong. Tell the user about every suspicion in plain words with its file and line, for example "demo.tsx line 4 holds a replacement character, so a symbol was probably lost when it was copied." Never repair or guess the code. Suggest a clean re-copy only when something looks cut off, such as `truncated-tail`, `unterminated-fence`, `unbalanced-brackets` or `placeholder-ellipsis`.
4. Only four reasons still stop an import with `IMPORT_PASTE_UNREADABLE`. They are `damaged:empty`, `format:too-large`, `format:no-code-found` and `format:no-component`. For the last one, when the user confirms the paste really holds code, split it by hand. Make a scratch folder, create one file per pasted file with its text exactly as pasted, and run `blockbase import <dir> --entry-point <file> --demo <file> --json` with the same provenance options. Tell the user you split it by hand and list the files you made. For the other three, tell the user what was missing and ask for the paste again.
5. Report what you found, what you asked, and what was recorded: the component id, files and their roles, entry point, author, license, source URL, every demo rewrite from `demo.rewrites` (from and to), and every warning (`shadcn-missing`, `alias-unresolved`, `remote-url`, `paste-suspect`, and the `demo-` warnings).
6. Continue with steps 5 and 6 above.

If `import` is absent from the installed registry, report the workflow as unavailable. Do not parse the source yourself or write catalog files by hand.
