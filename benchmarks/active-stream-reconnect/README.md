# Active Assistant reconnect benchmark

English | [中文](README.zh.md)

[reconnect.bench.client.ts](reconnect.bench.client.ts) measures the production Client fold when a reconnect carries an unfinished 100,000-delta reasoning prefix. A compiled private adapter reaches `ClientAssistantStream.replace()` without adding product exports. Three fresh plain-Node workers synthesize the compact baseline before timing; replacement time and retained heap after forced GC have separate median budgets. The next dense live frame must still be accepted. Standard hosted CI uses a 50 ms replacement expectation with the shared 1.25× headroom (63 ms ceiling); the retained-heap budget remains 30 MiB. Recorded-sample and synthetic-regression controls exercise the same time assertion as the worker verdict.

Build with `pnpm run build:bench`, then select `benchmarks/active-stream-reconnect` in `vitest.bench.config.ts`. This focused Node workload neither builds nor measures browser rendering. [Frontend performance budgets](../../.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md) records calibration and exclusions.
