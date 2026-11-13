# External source adapters

Adapters are executable, versioned acquisition boundaries. The host sends one
schema-versioned `acquire` request as JSON on stdin; an adapter emits exactly
one schema-valid `SourceEnvelope` on stdout. Adapters never receive catalog
write handles or normalization rules. Network is denied unless `adapter.json`
declares `capabilities.network: fetch` and the request explicitly sets
`fetch: true`; the host records that capability in the execution result.

The built-in file, directory, and stdin import paths remain the default escape
hatch when no external acquisition is needed.
