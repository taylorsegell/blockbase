# `blockbase validate`

Run only the commands declared by an adaptation manifest or its sibling bundle.

```text
blockbase validate <adaptation-manifest> --project <path> --json
```

Validation does not install dependencies. Failed commands return stable
command results and at most three bounded correction suggestions.
