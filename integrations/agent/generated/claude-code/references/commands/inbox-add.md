# `blockbase inbox add`

Park a paste or a local file or directory in the catalog inbox. The bytes are copied and not parsed.

```sh
blockbase inbox add --path ./Component.tsx --json
cat Component.tsx | blockbase inbox add - --entry-point Component.tsx --json
```

`--path` and stdin (`-`) are mutually exclusive. The item stays out of the catalog until `inbox import`.

A 21st.dev paste can be parked with `--from 21st` and stdin (`-`):

```sh
pbpaste | blockbase inbox add - --from 21st --json
```

The paste is read once when it is added, so a paste with no code or no component is rejected right away (`IMPORT_PASTE_UNREADABLE`) and nothing is parked. The raw paste is kept untouched, and the item shows `from: '21st'`.
