# `blockbase ui service status`

Report the login service without changing it: `installed`, `loaded`, the
definition `path`, `port`, and the `nodePath` the service runs. A warning
appears when that Node binary no longer exists, which happens after a Node
upgrade; run `blockbase ui service install` to refresh it.

```sh
blockbase ui service status --json
```
