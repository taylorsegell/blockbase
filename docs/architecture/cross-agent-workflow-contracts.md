# Cross-agent workflow contracts

Milestone 4.3 uses the installed CLI provider fixture harness at
`integrations/agent/harness/run.mjs`. The harness installs each generated
provider package into a temporary home, runs `agent install` and `agent check`,
discovers both focused skills, then invokes the unchanged capture and
find-and-fit CLI operations through that installed executable.

The matrix uses the same source and destination fixture for Cursor, Claude Code,
and Codex and normalizes checkout and temporary paths before comparing
transcripts. It asserts equivalent operation order, exit codes, diagnostic
codes, decisions, residual/risk state, validation state, and recovery actions.

| Fixture outcome | Decision | Selection exchanges | Bounded corrections |
| --- | --- | ---: | ---: |
| success | success | 1 | 0 |
| ambiguity | ambiguous | 1 | 0 |
| search miss | miss | 0 | 0 |
| partial normalization | partial | 1 | 1 |
| unsupported framework | unsupported | 0 | 0 |
| bounded validation failure | validation-failed | 1 | 1 |

Run the provider package and workflow checks with:

```sh
pnpm run agent-portability
```

This is real CLI/provider-package fixture evidence, not a mock claim about model
behavior. Live Cursor, Claude Code, and Codex playback is currently
`unverified` because no live-agent harness is configured; the runner reports
that boundary explicitly and does not promote fixture replay to live proof.
