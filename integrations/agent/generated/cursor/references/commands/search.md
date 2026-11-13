# `blockbase search <query>`

Search the manifest-derived SQLite index and return deterministic ranking and
selection evidence. Use project/profile compatibility options when the
destination is known; the operation never writes the catalog or destination.

```sh
blockbase search <query> --project <path> --json
blockbase search <query> --catalog <path> --framework <name> --json
```

An ambiguous result remains a decision for the user or calling agent; do not
silently select a component.
