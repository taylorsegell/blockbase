# `blockbase ui service uninstall`

Stop the login service and delete the one definition file Blockbase recorded,
then delete the service inventory. Nothing else is removed, and the catalog is
kept. A definition that is not recorded, or that was edited since install, is
left in place.

```sh
blockbase ui service uninstall --json
```

Confirm with the user before running this command.
