# Blockbase contracts v1

`@blockbase/contracts` is the only schema and runtime-validation authority for
the Blockbase application core and its CLI, UI, agent, and MCP adapters.

The exported contract inventory is:

- `SourceEnvelope` — acquired source files, assets, entry point, and provenance.
- `ComponentManifest` — identity, compatibility, interface, dependencies,
  tokens, quality, provenance, and integrity for a catalog component.
- `CanonicalTokenContract` — framework-neutral semantic token definitions.
- `NormalizationReport` — coverage, status, warnings, and exact residuals.
- `ProjectProfile` — bounded destination evidence, conventions, tokens,
  dependencies, conflicts, and validation commands.
- `AdaptationBundle` and `AdaptationManifest` — revision-pinned destination
  files, mappings, dependency delta, residuals, risk, checks, provenance, and
  optional target hashes used to refuse stale applies.
- `ValidationResult` — command-level destination validation evidence and bounded
  correction suggestions.
- `CliSuccessEnvelope` and `CliErrorEnvelope` — versioned machine output with
  warnings, stable operation names, errors, and bounded recovery actions.

All parsers require `schemaVersion: "1"`. `stableStringify` sorts object keys
recursively while preserving array order, making fixture round-trips suitable
for deterministic CLI output. The canonical fixtures live in `fixtures/v1/`.
