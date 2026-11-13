# `blockbase history undo`

Roll the whole catalog back by `--steps` changes (default 1) or `--to` a commit from `history list`. The rollback is a new commit, so it can itself be undone, and the search index is rebuilt afterwards. It refuses while another catalog write is in progress (`HISTORY_BUSY`) and when there are not that many changes (`HISTORY_NOTHING_TO_UNDO`).

```sh
blockbase history undo --json
blockbase history undo --steps 3 --json
blockbase history undo --to <commit> --json
```

Check `history list` first to see which changes will be undone. Confirm with the user before running this command.
