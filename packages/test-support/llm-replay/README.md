---
description: "Keyless LLM replay plugin for snapshot tests, for test authors booting the real agent against recorded model transcripts."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-replay

English | [中文](README.zh.md)

## Summary

`dsh-llm-replay` makes snapshot tests run without an API key: it installs a replay LLM adapter that serves model streams reconstructed from a recorded session JSONL fixture, so a test boots the real agent against a fixed transcript. The fixture is a projection of the persisted session log — each `assistant/message` or `assistant/attempt` embeds one model-call stream, and an explicitly marked local compaction call replays as one canonical stream. A `replay.override.json` sidecar covers what a settlement cannot reconstruct: a throw before any chunk, a cancel/hang, or an injected retry. Live sessions bind to recorded scripts by first-call order, so parent-and-subagent scenarios each get their own script. It is the model source behind the ACP and headless snapshot suites and the Web browser e2e lane.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package gives a keyless test a real agent with a fixed model transcript: mount it in place of a real LLM adapter, point it at a recorded fixture, and run the scenario exactly as if the model had produced the recorded output.

### Mounting it

With `providers` configured, the plugin registers a replay-only adapter whose catalog is available to scenarios that exercise model discovery; without `providers`, it installs the catch-all `llm/stream` waterfall used by tests that do not need discovery:

```yaml
- id: llm-replay
  name: '@deepseek-ai/dsh-llm-replay'
  config:
    providers:
      - id: deepseek-official
        name: DeepSeek
        retryPolicy:
          mode: normal
          backoff:
            initialDelayMs: 1
            maxDelayMs: 1
            jitterRatio: 0
        models:
          - id: deepseek-v4-flash
            contextWindow: 128000
          - id: deepseek-v4-pro
  # file/overrideFile/childFiles default to $DSH_SNAPSHOT_FILE /
  # $DSH_SNAPSHOT_OVERRIDE / $DSH_SNAPSHOT_CHILD_FILES, set by the snapshot
  # harness per scenario.
```

| Field | Default | Meaning |
|---|---|---|
| `file` | `$DSH_SNAPSHOT_FILE` | Path to the selected primary fixture: `session.jsonl` for v0 or `session.vN.jsonl` for a positive generation; required (config or env) |
| `overrideFile` | `$DSH_SNAPSHOT_OVERRIDE` | Optional `ReplayOverrideDoc` sidecar for the primary session |
| `childFiles` | `$DSH_SNAPSHOT_CHILD_FILES` | Recorded subagent child-session logs for a nested scenario |
| `providers` | — | Optional replay-only provider and model catalog; a model may declare `contextWindow`, text/image modalities, and positive `imageRequestTokens` when image-capable; invalid values fail at load and routes never perform provider I/O |
| `paceMs` | — (burst) | Optional per-chunk delay in ms for genuinely incremental delivery |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-replay) is the exhaustive source for every accepted field and its JSDoc.

### How the fixture works

The fixture is a projection of one selected persisted Session generation produced by running the real agent once — this plugin does not record. The snapshot harness supplies the numerically highest canonical parent path (`<scenario>/session.jsonl` for v0 or `<scenario>/session.vN.jsonl` for a positive generation), and validates filename/header agreement before replay. The fixture keeps the header and every event payload but omits body `seq`/`time` envelopes (`seq0`/`time0` for historical packed rows). Replay supplies contiguous sequences and deterministic timestamps, restores typed values replaced by snapshot tokens, rejects partial or mixed envelopes, decodes the complete physical artifact through the build-static Session format catalog, and migrates historical input in memory before it exposes events or the inherited cut; current input takes direct restoration. For a projected v0 header only, an absent `delegationDepth` denotes `0`. The parser never rewrites or renames the fixture. Runtime persistence continues to write complete logs. Replay expands the compact stream on each current-view `assistant/message` or `assistant/attempt`, so a recorded fixture replays the same logical stream the live model produced. A fixture may carry its `request/header` content tokenized to `{{system}}`/`{{tools}}`; replay materializes validation-only values, while derivation reads only Assistant settlements, marked summary events, and Session metadata. Every replay and comparison fixture must pass the same content-only catalog validation; replay never repairs a refused artifact.

### Nested agents

A scenario where a parent agent delegates to in-process subagents records one role per Session: parent `session[.vN].jsonl`, then contiguous children `session.<ordinal>[.vN].jsonl`. The snapshot harness supplies only the highest generation of each role. Live Session ids are freshly random each run, so replay binds each live Session to a recorded script by first-call order: the first live Session to make a model call claims the parent script, the next new Session the next child script, and so on, with each Session advancing its own cursor. More distinct live Sessions than recorded scripts fails loud.

### Failure modes and overrides

When replay serves `deepseek-official` with `ctx.deepseekLlmApiExtensions`, it prepares and accepts those fields after selecting a valid script entry and before yielding the first chunk. This mirrors the live adapter's post-2xx commit point, so durable acceptance watermarks and SDK event notifications behave the same in recording and replay. Replay supplies a synthetic `{ messages: [] }` base body: it proves acceptance side effects, not prepared field bytes.

Two failure modes are not reconstructable from a durable Assistant settlement alone: a pure throw before any chunk has no exception-bearing stream member, and a cancel/hang requires nontermination rather than a replayed finite prefix. A scenario that needs those supplies an optional sidecar (`<scenario>/replay.override.json`) that either replaces the derived script with a bare `ReplayEntry[]` or augments it with `{ patches: [{ at, entry }] }`, which keeps every derived call and swaps the named 0-based call indexes; `at` equal to the derived length appends the retry attempt after an injected transient throw. A `throw` entry accepts DeepSeek request extensions when it has prefix chunks; a zero-chunk throw defaults to pre-2xx non-acceptance and may set `accepted: true` for a post-2xx failure. A `hang` entry may name `readyFile`, which replay writes before waiting for cancellation so an external driver can cancel deterministically.

### What can go wrong

- **The fixture is not fully consumed** — `assertConsumed()` at teardown turns a scenario that silently drove fewer model calls than recorded into a crisp diagnostic; call it when installing replay directly in a test.
- **An unrecorded session makes a call** — replay fails loud and tells you to re-record the scenario.
- **A scripted placeholder matches nothing** — `{{fromRequest:<regex>}}` resolution validates the pattern and the request corpus and fails loud on no match, an invalid pattern, or an unterminated placeholder.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the replay plugin; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

Replay treats the selected projected Session generation as the fixture. One parser completes projected envelopes, validates and migrates the whole artifact through `sessionFormatCatalog`, and returns the current header, inherited cut, and event list as one result. `deriveReplayScript` expands each `assistant/message` or `assistant/attempt` stream in log order, so each durable settlement becomes one `chunks` entry; a non-empty stream without a `finish` chunk is the fingerprint of a thrown `stream()` and must be expressed through an override sidecar. A `compaction/summary` carrying `llmStreamCall: true` and a complete `rawOutput` replays as one canonical successful stream at that event's position. Scripted strings may embed `{{fromRequest:<regex>}}`; at stream time each placeholder resolves against the live request's string leaves, taking the pattern's last match and its first capture group (or the whole match) in place.

The committed-corpus test discovers every versioned `session*.jsonl` under `snapshots/`, `packages/`, and `scripts/snapshots/python-sdk-single-exe/`. Every artifact must restore to the current view through the real catalog. Any refusal fails with the artifact path, so the fixture owner must correct the invalid relationship before replay or comparison.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Types, fixture derivation, override validation, placeholder resolution, session binding, `installLlmReplay`, and the plugin export |
| [`tests/session-format-corpus.spec.ts`](tests/session-format-corpus.spec.ts) | Complete committed-generation restoration burn-in; every refusal is a failure |
| — | No runtime invariant companion is published; this test-only adapter consumes a fixed replay script; its stream grammar is checked by the LLM companion and fixture derivation tests. |

### Binding and stream flow

`installLlmReplay` loads the ordered scripts, then installs either a routed replay adapter (when `providers` is non-empty) or a catch-all `llm/stream` waterfall listener. Each live `stream()` call is keyed by its calling session id: a new session claims the next unclaimed script (parent first, because it streams before it can delegate), and calls without a `sessionId` share one anonymous session bound to the primary script. The returned `ReplayHandle` carries a disposer for HMR safety and `assertConsumed()`, which throws unless every recorded script bound to a live session and every bound cursor drained.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the replay adapter to the harness that records fixtures and the loop that consumes streams.

- [session-snapshot](../session-snapshot/README.md) — the snapshot support that records fixtures and drives replay, record, and refresh modes.
- [LLM package](../../llm/llm/README.md) — the provider stream contract and adapter registry replay implements.
- [Testing policy](../../../docs/testing.md) — the keyless snapshot tier and when it is required.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this keyless test adapter sends no request to a provider model; it only replays recorded assistant chunks into the test loop.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when replay cannot stand in for a live model. They are current package constraints, not a task backlog.

- **First-call-order script binding assumes sequential delegation** — a cut that runs sibling subagents concurrently would bind live sessions to recorded scripts non-deterministically; a stronger keying is deferred until such a scenario exists.
- **Only ordinary loop chunks and marked local compaction outputs are derivable** — a pure pre-chunk throw, a cancel/hang, or an unmarked external summarizer call needs the `replay.override.json` sidecar; replacement and patch forms affect only the primary session, and child scripts still derive from their logs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
