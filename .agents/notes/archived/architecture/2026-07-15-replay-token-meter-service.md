# Agent Note: Replay token meter service

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-15-replay-token-meter-service.zh.md)

## Problem

Context pressure is useful outside compaction. A compaction backend, an overflow guard, or a future request-policy plugin can all need the same answer: how many tokens does the durable request consume? Keeping that fold inside `dsh-compaction-basic` duplicates replay logic, makes measurement unavailable without compaction, and encourages callers to reuse stale accounting.

Provider usage is not a complete answer. It describes one successful call under one exact request envelope, while the current surface can grow, shrink, or be replaced afterward. Sessions also switch providers and models, old logs can omit the chunk seqs behind an assistant message, and usage fields separate input, cache-read, cache-write, output, and reasoning counts. A useful service therefore combines the latest exact anchor with conservative heuristic repricing and exposes the log revision consumed by each result.

## Decision

### One concrete LLM-family service

`@deepseek-ai/dsh-token-meter` is one concrete package under `packages/llm/` and registers `ctx.tokenMeter`. It is not split into an interface and backend before a second implementation exists. `TokenMeter` itself exposes `measure(session, requestHeader?)` and `estimateMessage(message)`; consumers call the singleton service directly.

The service has no configuration. Estimation uses a fixed four-characters-per-token heuristic plus structural overhead. There are no model profiles, capacity settings, density settings, tokenizer backends, or language-specific strategies. Exact provider/model capacity is a separate adapter-owned query, as specified by the [routed model context and compaction policy Agent Note](2026-07-20-routed-model-context-and-compaction-policy.md).

### Per-session replay folds

Each session owns one isolated incremental fold. Active folds advance from `session/event`; every read catches up through the durable tail, so listener ordering, seeded sessions, and service reload do not change the answer. The fold tracks canonical full request-header snapshots, step boundaries, surface appends and replacements, assistant usage, and the chunk seqs cited by each assistant message. A malformed next event fails transactionally and remains unread rather than partially mutating state.

`measure(session, requestHeader?)` synchronizes the fold once and returns scalar pressure together with positional per-node prices. `totalTokens` remains request-and-response pressure; `surfaceTokens` is the surface-only heuristic total and equals the sum of `nodes[].tokens`. A `requestHeader` override changes pressure pricing only, while the surface fields always describe the current session. `estimateMessage(message)` applies the fixed heuristic without session state. Each result is one detached, deeply immutable snapshot carrying one `logRevision`. Every measurement clones the current nodes and is therefore O(surface).

Provider usage is reused only when the measured canonical request envelope equals the latest successful-call anchor. Any provider, model, system, prefix, tool, or call-config change causes complete heuristic repricing. Surface changes remain a signed delta from a matching anchor, including negative values after a shrinking replacement. A later successful request replaces the earlier anchor, including across provider or model switches.

Usage sums the disjoint input, cache-read, cache-write, and output buckets. Reasoning is not added a second time. Every successful model call records an `assistant/message`, including content-less and max-token calls, with its exact earlier chunk seqs. An explicit empty `sourceEventSeqs` list means a known empty provider stream; an absent legacy list conservatively treats the durable assistant output as provider output.

### Compact-basic consumes, but does not own, measurement

`dsh-compaction-basic` requires `ctx.tokenMeter`; `CompactionEngine` gains no token methods or types. Configuration, the region transaction, and summarization stay in separate modules; the service registers automatic listeners itself, while `summarize()` remains its sole subclass hook. The singleton meter consistently prices pressure, retention, shadowed content, cited source events, and non-shrinking-summary rejection.

Automatic compaction uses one unified measurement for each threshold-and-retention decision. The region transaction measures after appending its durable `compaction/start` lock and again after asynchronous summarization, then compares the detached surface-node vectors. An intervening surface mutation prevents replacement; `logRevision` may advance for unrelated log-only facts without invalidating an unchanged selected span.

Compact policy has service-wide defaults: threshold ratio `0.8`, retained-tail ratio `0.16`, `summarizationProvider: ''`, `summarizationModel: ''`, `maxTokens: 8192`, `compactionRetries: 1`, `maxOverflowRetries: 1`, and `auto: true`. Top-level fields apply to every routed target; exact provider/model entries in `modelPolicies` partially override them. Pressure scales ratios against capacity resolved from the owning adapter, and `retainTokens` may replace `retainRatio`; retention must remain below the resulting threshold. The summarization provider and model must both be set or both be empty; an empty pair resolves the latest logged request target, then the `AgentOptions` pair.

Automatic pressure runs at `agent/pre-step` before request derivation and measures the canonical durable envelope produced under the provider/model actually selected by the preceding `agent/request`. A headerless session has no completed routed request to assess and produces no work; any routed target can use the singleton estimator. Canonical overflow recovery uses the same measurement for forced range selection and retries only after a proven surface replacement.

## Testing

Unit tests cover fixed estimation, envelope invalidation and anchor replacement, replay boundaries, immutable snapshots, routed pressure, convergence, overflow generation proof, and rollback. A real Loader/Include fixture verifies the zero-config token-meter and compaction-basic load path in dependency order.

## Alternatives considered

- **Keep estimation inside `CompactionEngine`** — rejected because measurement has consumers and replay semantics independent of compaction; it would also force every compactor to expose the same unrelated API.
- **Split a token-meter interface from a heuristic backend immediately** — rejected because only one implementation exists. One concrete service preserves the future seam without speculative packages or configuration.
- **Put model-keyed windows and density profiles in the meter** — rejected because replay estimation does not own model routing or capacity facts. The route-owning adapter exposes capacity, while compaction-basic owns the consumer-specific threshold and retention policy.
- **Keep separate scalar and surface measurements** — rejected because callers would need two reads and revision matching for one decision. A scalar-only read could avoid cloning nodes below threshold, but the split API introduces a caller-side race window; the unified snapshot accepts O(surface) cloning in exchange for coherence.
- **Treat provider usage as portable between envelopes** — rejected because model, tools, prefixes, and call config are request facts. Mismatch reprices the whole current request.

## Consequences

- Token pressure has one replay-aware owner that compaction and future plugins can share.
- The default makes the meter a zero-config composition entry; deployments configure capacity on each route-owning adapter and optional policy overrides on compaction-basic.
- Fixed heuristic pricing remains an estimate of provider behavior and is not an exact tokenizer or request serializer.
- Every measurement clones the current positional surface and therefore costs O(surface), including pressure checks that finish below threshold.
- Measurements fail loudly on malformed durable boundaries. This turns corrupted replay into a named integration failure instead of silently drifting pressure.
- Post-step pressure reads the exact logged routing/tools/prefix boundary; provider overflow classification remains the adapter-maintained backstop for requests rejected before a successful usage anchor.
