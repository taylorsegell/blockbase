# `blockbase ui status`

Report whether the catalog page is answering. The page counts as running only
when `/api/health` returns JSON that names a catalog root. The result also
carries the login service status. The command only reads.

```sh
blockbase ui status --json
```

Use `data.running` and `data.url` to give the user a link. Do not start the
server from this command.
