# Authoritative preview projections

`generatePreviewProjections` reads only committed `components/*/*/component.json`
manifests and the rebuildable SQLite index. It emits the same deterministic
projection shape for the legacy preview's registry and catalog consumers:

- components are sorted bucket-first (`brick`, `build`, `creation`), then family
  and slug;
- `name`, `bucket`, `path`, and `exported` are copied from the migration-produced
  identity/path overlay; tags come from authoritative manifests;
- category routes and facet inputs are derived fields, not a second taxonomy;
- collections are an optional reversible export/import record. They do not
  become component identity or taxonomy authority.

Use `writePreviewProjections` to publish `registry.json` and `catalog.json`, and
`checkPreviewProjectionDrift` in CI. Generated files must not be hand-edited;
the check fails if either file differs from regeneration. Duplicate component
IDs, namespace/slug identities, and catalog paths fail generation. The one
documented shared-path exception is accepted only when both migrated manifests
explicitly mark `catalog.sharedPath` and use the snowboarder path.
