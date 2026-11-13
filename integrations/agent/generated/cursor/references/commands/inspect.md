# `blockbase inspect <component-id-or-alias>`

Show one component manifest, quality report, package path, and revision path.

```sh
blockbase inspect <component-id-or-alias> --json
```

The revision files are immutable.

`quality.warnings` holds string entries. Entries prefixed `demo-file:<relative path>` and `remote-url:<relative path>` report a leftover demo file and a remote asset URL respectively.
