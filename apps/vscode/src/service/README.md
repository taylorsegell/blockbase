# service/

Talks to the local Blockbase service. Tests must only use fakes or ephemeral ports.

- `status.ts` (ARK-419): `blockbase ui status --json` through an injectable `CliRunner` (execFile, argument arrays, no shell) and classifies it as `up`, `installed-down`, `no-service` or `unknown`.
- `serviceRecovery.ts` (ARK-419): Install service / Run for this session / Restart, the session child (killed on deactivate), and the backoff retry that waits for the page.
- `notRunningView.ts` (ARK-419): the "catalog page isn't running" HTML the panel hosts.

Panel hook: call `recovery.check()` before loading and when the iframe fails. While the state is not `up`, render `renderNotRunningHtml(state, nonce)` and pass `{ type: "blockbase.service", action }` messages to `recovery.handleAction(action)`. Reload the page when `onDidChangeState` fires `up`.

ARK-423 (remote workspaces) adds its own files here.
