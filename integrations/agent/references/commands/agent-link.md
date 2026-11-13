# `blockbase agent link`

Create or repair links for the Blockbase umbrella skill, both focused skills,
and the checkout's `blockbase` executable. Existing correct links are reused;
stale symlinks are repaired; regular files are never overwritten.

```sh
blockbase agent link --home <isolated-agent-home> --json
```

The home path is runtime input and is not embedded in canonical plugin files.
