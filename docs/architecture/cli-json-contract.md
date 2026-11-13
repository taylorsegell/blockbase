# Blockbase CLI JSON contract

The `@blockbase/cli` package exposes the `blockbase` npm bin. The root pnpm
workspace is authoritative for installation; the package `bin` field resolves
the executable to `packages/cli/dist/index.js` after `pnpm build`.

## Commands

```text
blockbase catalog locate [--catalog <path>] [--json]
blockbase catalog list [--catalog <path>] [--json]
blockbase catalog validate [--catalog <path>] [--json]
blockbase doctor [--catalog <path>] [--json]
blockbase adapt <component-id> --project <path> [--out <path>] [--json]
blockbase add <component-id> --project <path> (--dry-run|--apply) [--json]
blockbase validate <adaptation-manifest> --project <path> [--json]
```

`catalog validate` is a read-only legacy-catalog scan. `doctor` runs the same
core scan and adds a `status` (`healthy` or `unhealthy`) to successful data.
Both commands call `@blockbase/core`; the CLI contains no catalog parsing or
taxonomy rules.
Adaptation preparation, add planning/application, and destination validation
also call shared core services. Preparation and dry-run never install
dependencies; apply writes only manifest-listed files after revision and target
hash checks.

## Output and exits

With `--json`, stdout contains exactly one pretty-printed JSON v1 envelope and
no human diagnostics. Success envelopes contain `schemaVersion`, `ok: true`,
`operation`, `data`, and `warnings`. Failure envelopes contain those versioned
fields plus a stable `error` and at most three bounded `recoveryActions`.
Human diagnostics are written to stderr in both modes. Human mode does not
change operation selection or exit behavior.

| Exit | Constant | Meaning |
| ---: | --- | --- |
| 0 | `ok` | Operation succeeded (warnings may be present). |
| 2 | `usage` | Invalid command shape or option. |
| 3 | `notFound` | No catalog was found after all configured locations were checked. |
| 4 | `invalidInput` | Reserved for invalid operation input in later commands. |
| 5 | `conflict` | Reserved for conflicts in later commands. |
| 6 | `unsupported` | Reserved for unsupported operations in later commands. |
| 7 | `validationFailed` | Catalog diagnostics include one or more errors. |
| 10 | `internal` | Unexpected internal failure; details go to stderr. |

Catalog resolution checks `--catalog`, `BLOCKBASE_HOME`, and the platform data
directory in that order. A missing catalog is never created implicitly, and the
error envelope includes every checked location plus safe recovery commands.
