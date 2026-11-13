# `blockbase ui service install`

Install the user login service that keeps the catalog page running: a launchd
agent on macOS (`~/Library/LaunchAgents/com.blockbase.ui.plist`) or a systemd
user unit on Linux (`~/.config/systemd/user/blockbase-ui.service`). Ownership
is recorded in `<catalog>/.blockbase-service.json`. An existing definition that
Blockbase does not own, or that was edited after install, is a conflict
(`SERVICE_CONFLICT`) and is never overwritten. Identical content is a no-op.
Without `--port` or `--allowed-host`, the values recorded by the previous
install are kept.

```sh
blockbase ui service install --json
blockbase ui service install --port 47821 --allowed-host <name> --json
```

Confirm with the user before running this command. Other platforms return
`SERVICE_UNSUPPORTED`.
