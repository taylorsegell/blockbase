# `blockbase add`

Plan or explicitly apply an existing component adaptation.

```text
blockbase add <component-id> --project <path> --dry-run --json
blockbase add <component-id> --project <path> --apply --json
```

`--dry-run` is read-only. `--apply` writes only the files listed in the
returned adaptation manifest and refuses changed targets or stale revisions.
Dependencies are proposed in JSON and are never installed by this command.
An earlier `adapt --out` result can be applied with `--manifest
<staging>/manifest.json`.
