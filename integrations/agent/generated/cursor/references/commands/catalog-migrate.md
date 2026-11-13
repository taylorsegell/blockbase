# `blockbase catalog migrate`

Plan, apply, or resume the audited migration of a legacy filed catalog into a
separate Blockbase catalog root. Plan mode is read-only and reports per-entry
IDs, revisions, conflict resolutions, skips, required decisions, structural
changes, and source hashes.

```sh
blockbase catalog migrate --catalog <legacy-root> --target <catalog-root> --dry-run --json
blockbase catalog migrate --catalog <legacy-root> --target <catalog-root> --apply --json
blockbase catalog migrate --catalog <legacy-root> --target <catalog-root> --resume <report.json> --json
```

The legacy catalog and component files are never overwritten or deleted.
Unavailable upstream originals are labeled `legacy-filed`; the migration does
not claim byte identity to an unavailable source.
