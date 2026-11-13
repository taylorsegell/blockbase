# `blockbase import <source>`

Safely import a local React file, directory, stdin source, or 21st.dev paste into an immutable revision.

```sh
blockbase import <file-or-directory> --json
cat Component.tsx | blockbase import - --entry-point Component.tsx --json
```

The importer preserves original bytes, records provenance and SHA-256 integrity, rejects unsafe paths and unsupported frameworks, and never executes imported code or installs dependencies.

## 21st.dev paste

```sh
pbpaste | blockbase import - --from 21st --source-url https://21st.dev/example --license MIT --json
pbpaste | blockbase import - --from 21st --name "Skyline Card" --json
```

`--from 21st` reads a 21st.dev paste from stdin (the source must be `-`). The non-demo files become the block. The demo file is installed beside `component.json` as `demo.tsx`, and its imports of pasted files are rewritten to `@block`. The full paste is kept as `source-paste.txt` beside `component.json`. Both files sit outside the revision, so they do not change the revision identity, and `source-paste.txt` describes only the last paste imported for that component. Packages from the install list and import lines are recorded as dependencies. An author found in the paste is recorded unless `--author` is given. The license is `unknown` unless `--license` is given; it is never guessed.

The result adds `paste` (format, files with roles, entry point, author hint, suspicions, normalizations, raw paste path, warnings) and `demo` (`installed`, `path`, `rewrites`, `warnings`). Report every warning to the user: `shadcn-missing:<spec>`, `alias-unresolved:<spec>`, `remote-url:...`, `paste-suspect:<file>:<reason>`, and the `demo-*` warnings.

## Directory with a demo

```sh
blockbase import ./scratch --entry-point skyline-card.tsx --demo demo.tsx --json
```

`--demo <file>` names a file inside a directory source that becomes the catalog-page demo instead of part of the block. It is removed from the block before hashing, so the revision identity is the same as importing the folder without that file. It cannot be the entry point and cannot be combined with `--from`.

## Provenance options

`--source-type <type>` (one of `file`, `directory`, `stdin`, `paste`, `url`, `adapter`), `--source-url <url>`, `--license <license>`, `--author <name>`, and repeatable `--tag <tag>` work with every source. Explicit options win over values read from the source and over `--manifest`; tags are added to the existing ones. Without any of these options, `--from`, or `--demo`, the import behaves exactly as before.

## Errors

| Code | Meaning | Exit |
| --- | --- | --- |
| `IMPORT_PASTE_UNREADABLE` | The paste could not be split into files. Messy pastes import with suspicions instead, so `details.reasons` only holds `damaged:empty`, `format:too-large`, `format:no-code-found` or `format:no-component`. Ask for the paste again, or when it really holds code, split the files by hand and import the folder with `--demo`. Nothing is imported. | 4 |
| `IMPORT_PASTE_NAME_REQUIRED` | The paste is bare code with no file names; pass `--name`. Nothing is imported. | 4 |
| `IMPORT_INVALID_PATH` | `--demo` was used on a source that is not a directory, or names a missing file or the entry point (`details.demo`). | 4 |
| `IMPORT_COMMIT_FAILED` | Writing failed. With `details.stage: 'demo'` the demo or raw paste could not be written; `details.committed: true` means the new revision was kept. | 10 |

A wrong option combination or an unknown `--source-type` is a usage error (exit 2).
