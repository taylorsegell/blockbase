# `blockbase history list [component]`

List recent catalog changes, newest first. Each entry gives the commit, time, summary, operation, the actor that made it, and the components and catalog files it touched. Pass a component id, slug, or `namespace/slug` to see only that component's changes; `namespace/slug` also works for a component that has since been removed.

```sh
blockbase history list --limit 10 --json
blockbase history list <component-id-or-slug> --json
```

This command is read-only.
