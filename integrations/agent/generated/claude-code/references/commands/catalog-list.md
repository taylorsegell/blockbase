# `blockbase catalog list`

List every catalog component and every collection in one read-only call. It
reads the same manifests, migration-report buckets, and collection metadata the
catalog page uses, so a client can mirror the page without reading the catalog
directory itself. It never writes to the catalog.

```sh
blockbase catalog list --json
blockbase catalog list --catalog <path> --json
```

The JSON envelope is the only machine contract. On success, `data` is:

- `components[]`: `componentId`, `namespace`, `slug`, `displayName`,
  `description`, `category`, `tags[]`, and `bucket` (the bucket recorded by the
  legacy migration, or `null` for components imported since).
- `collections[]`: `id`, `title`, `reserved`, and `slugs[]`.

A missing catalog returns the checked locations and bounded recovery actions.
