# `blockbase agent unlink`

Remove only the Blockbase symlinks from an agent home. The operation is
idempotent and preserves regular files occupying a link slot.

```sh
blockbase agent unlink --home <isolated-agent-home> --json
```
