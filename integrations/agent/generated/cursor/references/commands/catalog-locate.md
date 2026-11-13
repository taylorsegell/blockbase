# `blockbase catalog locate`

Resolve the catalog location without creating a catalog. Use `--catalog` for an
explicit path or rely on `BLOCKBASE_HOME` and the platform data directory.

```sh
blockbase catalog locate --json
blockbase catalog locate --catalog <path> --json
```

The JSON envelope is the only machine contract. A missing catalog returns the
checked locations and bounded recovery actions.
