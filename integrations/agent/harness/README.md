# Cross-agent workflow harness

`run.mjs` is the Milestone 4.3 portability harness. It installs each generated
provider package into an isolated temporary home, verifies discovery of
`blockbase-capture` and `blockbase-find-and-fit`, and executes the real installed
`blockbase` CLI symlink against the same source and destination fixtures.

The workflow transcript records only observable contracts: operation, normalized
argv, exit code, diagnostics, decision, selection state, residual count, risk,
validation status, and bounded recovery actions. Absolute temporary and checkout
paths are replaced before the three provider transcripts are compared.

Run the complete fixture matrix after building the CLI:

```sh
pnpm run agent-portability
```

The fixture replay covers success, ambiguity, search miss, partial normalization,
unsupported framework, and bounded validation failure. It is provider-harness
evidence, not model evidence: no live Cursor, Claude Code, or Codex harness is
started by this command. Reports explicitly mark live-agent verification as
`unverified`; a future live runner must provide its own receipts before that
boundary can be promoted.

Each selected search is counted as one selection exchange. A partial adaptation
or failed/blocked validation is counted as one bounded correction exchange; the
runner does not permit an open-ended correction loop.
