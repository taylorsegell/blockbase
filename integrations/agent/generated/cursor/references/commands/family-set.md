# `blockbase family set <component> --family <slug>`

Set a component `category` to a family slug from `taxonomy.json`. `--create` adds a missing family. Without `--create`, an unknown family is refused.

```sh
blockbase family set <component-id-or-slug> --family cards --create --name Cards --json
```

Confirm with the user before running this command. Pass `--create` only when the user wants a new family.
