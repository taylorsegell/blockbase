# Scale benchmark

The benchmark generates 10,000 component manifests and measures warm in-process
index calls with `process.hrtime.bigint()`. Exact ID lookup uses a prepared
SQLite `component_id` query and must have a median below 50 ms; typical public
text search must have a median below 200 ms.

```sh
pnpm build
node benchmarks/run.mjs --entries 10000 --samples 25 --write-report /tmp/blockbase-benchmark.json
```

The report records the runtime, platform, architecture, dataset revision,
sample count, medians, thresholds, and pass/fail result. Timing claims apply
only to the documented profile recorded in that report.
