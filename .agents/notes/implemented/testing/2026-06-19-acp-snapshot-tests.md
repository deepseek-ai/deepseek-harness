# Agent Note: ACP snapshot tests — record-once / replay-deterministic

Status: implemented

English | [中文](2026-06-19-acp-snapshot-tests.zh.md)

## Problem

Unit tests do not exercise the complete assembled-agent subprocess or its ACP automation wire, while real-API tests are nondeterministic and key-gated. Loader wiring, backend behavior, and protocol output can therefore regress despite green unit coverage, as the [default-export postmortem](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) demonstrated.

The blocker for a full-transcript test is the model: the agent's output is driven by a non-deterministic LLM, and a key-gated test that hits the real API on every run is neither deterministic nor CI-runnable. The tier needs the fidelity of a real run with the determinism of a fixture.

## Decision

A recorded-session snapshot starts a shipped profile through `dsh`, drives its public interface, and compares normalized output with committed expected outputs. ACP-owned scenarios additionally drive the stdio protocol and compare its transcript. A session log recorded once from the real API supplies all later model streams. The fixture is a [projection of the product's persisted JSONL](2026-08-18-session-snapshot-envelope-projection.md): its header and payloads remain, while body sequence/time envelopes are omitted.

The [session-log snapshot corpus decision](2026-08-24-session-log-snapshot-corpus.md) supersedes this note's ACP-specific placement and controller ownership. This note remains the rationale authority for session-log fixtures, replay derivation, exceptional overrides, normalization, and ACP transcript comparison.

### The fixture projects the persisted session JSONL

Each scenario's selected highest parent generation is harvested from a real run: `session.jsonl` for v0 or `session.vN.jsonl` for a positive generation. The compact streams embedded in `assistant/message` and `assistant/attempt` reproduce model attempts; tool, message, and boundary events capture the harness behavior. One ordinary Session generation therefore serves as both replay source and behavioral expected output.

Every current v2 session-format fixture uses one physical row per durable event. Retained v0 and v1 predecessor generations may contain their frozen packed-row representation and remain immutable. Ordinary replay and log comparison prove that the assembled process selects, migrates, consumes, and reproduces the current generation.

### Replay derives the model script from the log

`llm-replay` short-circuits the provider-agnostic `llm/stream` waterfall. `deriveReplayScript()` expands each recorded `assistant/message` or `assistant/attempt` stream into one positional call and validates its terminal chunk. A `compaction/summary` with `llmStreamCall: true` contributes one call at its durable log position: replay reconstructs canonical block boundaries from `rawOutput`, retains recorded usage when present, and supplies a terminal `stop`. The marker distinguishes that local call from template or remote summaries whose retained `rawOutput` did not consume this context's adapter.

### The in-memory replay entry honors the full LLM contract

`deriveReplayScript` produces a list of `ReplayEntry`, the in-memory unit the replay listener serves positionally:

```
{ kind: 'chunks', chunks: StreamChunk[] }
| { kind: 'throw', chunks: StreamChunk[], message: string, code: string }
| { kind: 'hang' }
```

Logs derive chunk or throw entries from durable Assistant settlements and explicitly marked compaction calls. Pre-stream throws, hangs, and external summarizer calls have no reconstructable local stream representation, so those scenarios provide `replay.override.json`. A throw entry may include prefix chunks for mid-stream failure. Explicit overrides avoid inferring adapter behavior from lossy turn-end reasons or provider output alone.

### Positional replay, one in-flight stream

Replay is positional and therefore permits only one in-flight model stream per scenario. Concurrent-session snapshots require request-keyed entries. Changed call order requires re-recording, and missing or exhausted fixtures fail loudly.

### Recording harvests the log; keyless replay needs a providerless config

Recording runs the scenario with the real `llm-deepseek` adapter and the JSONL persistence backend configured with `persistenceCompression: 'none'`, then projects the produced `.jsonl` into the scenario dir. The explicit raw mode keeps harvested logs line-readable while ordinary deployments use the backend's compressed default; eligible chunk runs still use the default packed storage rows. Per-event appends are durable, but the harness shuts the subprocess down gracefully (close stdin → `await ctx.dispose()`) before harvesting so the final events are flushed. `llm-replay` itself does no recording — it is replay-only.

Replay uses a `cordis.snapshot.yml` overlay that replaces the real adapter with `llm-replay` while retaining the live composition. Recording uses the ordinary config and a harness-supplied persistence root. Replay mode skips `.env` loading, so a stray API key cannot trigger a live call. See the [single-source config Agent Note](../../archived/testing/2026-07-04-single-source-acp-replay-config.md).

### Two outputs: normalize, then compare

A snapshot run asserts **two** normalized outputs, because the harness's external APIs are distinct:

1. The **stdout transcript** — the framed ACP JSON-RPC responses and committed-message updates an automation client receives. It catches regressions in the transport contract and is compared against a committed `stdout.expected.jsonl`.
2. The **re-persisted Session JSONL**, normalized and compared with the selected highest parent fixture. The same generation is both replay source and expected log; a fresh current writer may produce a higher canonical filename while the logical comparison retains the older replay input. Prompt and tool bulk are scrubbed; one scenario per header class pins the remaining header sequence. The pin owns readable prompt and tool-schema sidecars by default, or names another pin as either source when the complete sequence is identical, so each distinct sidecar version is committed once. Fixture guards reject duplicate sidecar content, and record/refresh rejects shared claimants that generate different bytes. The original header-pinning rationale is preserved in the [header-pinning Agent Note](../../archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md). Override scenarios derive model behavior solely from their sidecar.

The surfaces are complementary: stdout covers the minimal automation wire, while JSONL covers loop, tool, and boundary structure that the wire intentionally omits.

Normalization replaces session, cwd, protocol-id, timestamp, path, and process volatility; fixture projection omits body sequence/time envelopes without changing payload references. Record and refresh also store a generated workspace and its filesystem-resolved aliases as `{{cwd}}` in the replay fixture, so platform temp roots and random basenames do not affect recordings; authored temp paths and cwd values under an explicit `workspaceParent` remain literal. Scenarios constrain real bash use to stable commands. The stdout expected output remains wire-shaped JSONL and every raw line must parse as JSON. Ordinary Vitest snapshot updates write only the stdout expected output; the explicit `record` and `refresh` modes own replay-fixture writes.

### Isolation: normalization now, sandbox later

Tool determinism comes from a generated cwd, scrubbed environment, fresh non-login shell, constrained commands, and normalization. The cwd defaults to the platform temp directory; a scenario can instead supply its parent when temp is an always-writable policy root and the behavior needs an independent project location. Concurrent replay runs own separate cwd, persistence, and fixed-length scenario-keyed spill roots, so one scenario's teardown cannot delete another's in-flight full-output recovery while real-path preview budgets remain stable. This tier does not claim OS confinement. A sandboxed executor can replace the local backend through the existing [capability seam](../architecture/2026-06-13-capability-seams.md) if a stronger tier is needed.

### The replay plugin is its own package

`@deepseek-ai/dsh-llm-replay` is a support package rather than example-local glue. It replaces the real adapter by short-circuiting `llm/stream` with streams reconstructed from JSONL, and its package placement keeps the replay logic under normal coverage gates.

### Two subcommands, replay in the default gate

`pnpm run test:snapshot` replays committed fixtures keylessly; `test:snapshot:record` uses the real API and writes the projected current Session generation plus interface-specific expected output. The same keyless gate discovers canonical repository JSONL generations by filename/header agreement and rejects any fixture that differs from the shared codec's projected canonical packed representation. Missing roles fail loud. Every ACP scenario carries `input.json`, `stdout.expected.jsonl`, and one selected parent `session[.vN].jsonl`; no-model cases use a header-only log. Other profiles derive ordinary accepted user input from the selected parent generation and retain only controller input that the accepted Session cannot reconstruct in `snapshot.yml`. `replay.override.json` is required only for scenarios whose successful model behavior cannot be derived from the log. Fixture guards reject missing, mismatched, noncanonical, and orphaned files. Both commands accept scenario filters.

## Alternatives considered

- **A hand-authored `llm.json` of model chunks** — the earlier draft; reusing the real session log makes the fixture a genuine product of the system rather than a hand-built mock, and doubles it as a behavioral expected output.
- **A compulsory replay override for every compaction summary** — rejected: the durable summary event already fixes a successful local call's position, complete output, and optional usage. An explicit local-call marker preserves that single-source fixture without inventing a call for template or remote summarizers.
- **A byte-level HTTP-record library (Polly/nock/MSW)** — rejected: adapter-specific, awkward with streaming SSE, and lower-level than the thing under test.
- **Synthesizing throw/cancel entries from `turn/end {kind:'error'|'aborted'}`** — rejected: it couples `llm-replay` to loop-internal turn-closing semantics, and the `turn/end` reason is lossy (it cannot distinguish a thrown 401 from a finish-error); the explicit `replay.override.json` sidecar is the cleaner seam.
- **Copying both request-header sidecars beside every class pin** — rejected: prompt and tool-schema composition vary independently, so a change to one shared component would churn byte-identical files across unrelated class pins. Explicit per-component sources retain one structural pin per class without duplicating content.

## Consequences

The tier adds reviewed per-scenario session, manifest, interface-specific expected output, optional override, and optional workspace fixtures, plus one file for each distinct pinned prompt and tool-schema sequence. Workspace seeds are copied into the generated cwd for both record and replay. In return the tier provides deterministic keyless coverage through the real Loader and tool composition, including an assembled context-overflow recovery whose marked compaction summary supplies the auxiliary call. The ACP subtree now retains only protocol behavior; headless, SDK, and Web own the scenarios whose behavior belongs to those interfaces.

This Agent Note relates to but does not supersede the [proposed determinism Agent Note](../../proposed/testing/2026-06-11-deterministic-and-stress-testing.md): that proposal's "universal replay fixture" re-derives session *message history* after every test (an internal-consistency invariant), whereas these snapshots pin assembled behavior plus interface-specific output. They remain complementary.
