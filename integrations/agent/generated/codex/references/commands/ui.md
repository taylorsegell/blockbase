# `blockbase ui`

Serve the catalog page on a loopback port in the foreground until interrupted.
The catalog root is `--catalog`, then `BLOCKBASE_HOME`, then `~/.blocks`. With
`--json` the command prints `{url, port, catalogRoot}` once, after the server
has started. The page is at `http://127.0.0.1:<port>/#home`; the default port is
47821.

```sh
blockbase ui --json
blockbase ui --port 47821 --allowed-host <name> --open
```

The server is built from this checkout (`pnpm build`); without it the command
fails with `PREVIEW_NOT_BUILT`. Most users run the login service instead; see
`blockbase setup`.
