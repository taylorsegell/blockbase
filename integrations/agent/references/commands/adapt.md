# `blockbase adapt`

Prepare a deterministic, revision-pinned destination bundle without writing
the destination project.

```text
blockbase adapt <component-id> --project <path> [--catalog <path>] [--revision <revision>] [--out <staging-path>] --json
```

The result contains destination files, token mappings, dependency proposals,
residuals, provenance, and manifest-listed validation commands. Preparation
never installs dependencies.
