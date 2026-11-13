# `blockbase setup`

Create the catalog when it is absent and install the user login service that
serves the catalog page. The catalog root is `--catalog`, then `BLOCKBASE_HOME`,
then `~/.blocks`. The command is idempotent: an existing catalog is left alone
(`catalog: present`), a legacy `catalog.yaml` catalog is reported with a
migrate repair and not touched (`legacy`), and a directory holding unrelated
files is refused with `SETUP_CATALOG_CONFLICT` and never written to.

```sh
blockbase setup --json
blockbase setup --no-service --json
```

The result has `catalog` (`created`, `present`, `legacy`), `service`
(`installed`, `refreshed`, `running`, `skipped`, `failed`), the page `url`, and
`issues`, each with an optional `repair` command. `--no-service` creates the
catalog only. `--port` and `--allowed-host` configure the service; when they
are omitted, the values recorded by the previous install are kept.

Confirm with the user before running this command: it writes the catalog and a
login service definition. Remove the service with `blockbase ui service uninstall`.
