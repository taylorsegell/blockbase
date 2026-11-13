# `blockbase history restore <component> --to <commit>`

Put one component back as it was at a commit from `history list`, leaving every other component, collection, and family alone. If the component did not exist at that commit, it is removed. The restore is a new commit and the search index is rebuilt afterwards.

```sh
blockbase history restore <component-id-or-slug> --to <commit> --json
```

Check `history list <component>` first to pick the commit to restore to. Confirm with the user before running this command.
