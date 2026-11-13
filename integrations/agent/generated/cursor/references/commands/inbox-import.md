# `blockbase inbox import <id>`

Import a parked item with the catalog importer, then discard the inbox item when the import succeeds.

```sh
blockbase inbox import <id> --namespace local --slug example --json
```

Provenance options work here as they do on `import`: `--source-type <type>`, `--source-url <url>`, `--license <license>`, `--author <name>`, and repeatable `--tag <tag>`.

```sh
blockbase inbox import <id> --source-url https://21st.dev/example --license MIT --tag hero --json
```

A 21st.dev paste parked with `--from 21st` is imported the same way as `import - --from 21st`, and the result carries the same `paste` and `demo` summaries; report their warnings and suspicions to the user. A paste with no file names needs `--name` (`IMPORT_PASTE_NAME_REQUIRED`); the item stays parked until the import succeeds.

Confirm with the user before running this command.
