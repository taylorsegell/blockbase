# `blockbase project inspect --cwd <path>`

Read bounded React project conventions, tokens, dependencies, and validation
commands without writing the destination project.

```sh
blockbase project inspect --cwd <path> --json
```

Unsupported frameworks and conflicting conventions are returned as structured
errors with bounded recovery actions.
