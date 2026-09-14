---
description: "Shared compaction contract for backend implementers and deployers: what conversation condensation does, when to use it, and how to build a backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction

English | [中文](README.zh.md)

## Summary

`dsh-compaction` lets a long session condense its older history into a single summary message, keep the recent conversation intact, and continue as if the summary had always been there — with a backend such as `dsh-compaction-basic` and the optional `/compact` command. The shadowed content stays in the session log, so replaying the session deterministically reproduces the same condensed conversation. Reach for this package when you implement a condensation backend, build something that triggers condensation, or need to recognize condensed messages — it performs no condensation itself. Choose the shipped backend when you want the feature working out of the box.

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

Decide first what you need. The shipped backend plus the `/compact` command give you automatic and on-demand condensation with no code; this package only matters when you extend or reimplement the feature. The sections below describe what condensation does, how to turn it on, and how to write a backend.

### When to choose it

Choose `dsh-compaction-basic` when a model-written summary fits your needs: you get condensation automatically as the conversation grows, and on demand through `dsh-command-compact`. Choose this package when you write a backend with a different summarizer — a fixed template or a remote service — or when you build something that triggers condensation programmatically. Do not mount it alone: without a backend nothing condenses.

### What condensation looks like

When condensation runs, the selected older span of the conversation is replaced by one summary message; recent history is untouched and the conversation continues from the summary. Condensation can be triggered automatically as token pressure builds, on demand, or over an explicit span; the result reports which history was condensed and the estimated tokens freed.

### Turning condensation on

Mount the shipped backend to register the condensation service, and add `dsh-command-compact` for the on-demand command:

```yaml
- name: '@deepseek-ai/dsh-compaction-basic'
- name: '@deepseek-ai/dsh-command-compact'
```

With these two rows the feature is on: the conversation condenses automatically as it grows, and `/compact` condenses immediately on request and reports how many history items were replaced. If no backend is mounted, nothing condenses and `/compact` fails; the full dependency chain for the shipped backend is in its own README.

### Implementing a backend

Extend the provided base class and implement three operations: one that decides and performs condensation for an automatic trigger, one that condenses on demand, and one that condenses an explicit range of the conversation. Load your class as a plugin and it becomes the condensation service for the composition. The exact signatures, the failure rules, and the checkpoint marker every backend must produce are in the implementation section below and in the [compaction subsystem reference](../../../docs/subsystems/compaction.md).

### Recognizing condensed history

Messages a backend wrote as summaries carry a stable marker, so any consumer can recognize condensed history after persistence or cloning without knowing which backend produced it. The marker is exported from the package root and from a Cordis-free subpath that client and wire programs can import.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the contract in API terms and the design decisions behind it; the feature-level behavior is covered in [Use this package](#use-this-package).

### Design philosophy

The seam is built on one split and three commitments:

- **Abstract contract, concrete backends.** The interface states what condensation does; providers own policy, retention, and summarization so each role evolves and swaps independently.
- **Session and LLM vocabulary are part of the contract.** The operations act on a `Session` and the summary uses `ContentBlock`, so the Service Definition depends on `dsh-session` and `dsh-llm` despite the general Cordis-only guidance — a deliberate deviation recorded in the [compaction capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).
- **The log-recorded bracket is the lock.** `compaction/start` is appended before summarization yields and `compaction/end` releases; every failure makes exactly one close attempt, and a failed close leaves the unmatched start as the intentional busy signal.
- **The surface is mutated exactly once.** The summary rides on a `user/message` replacement inside the bracket; all `compaction/*` events stay log-only.

### Service API

The contract is three abstract operations a backend implements: `compactIfNeeded` for automatic `pressure` or `context-overflow` triggers, `compactNow` for one explicit on-demand reduction, and `compactRegion` for a caller-selected surface range. Reusable request measurement is a separate service, `ctx.tokenMeter`. The exhaustive per-operation semantics live in the [compaction subsystem reference](../../../docs/subsystems/compaction.md); the exact signatures are in [`src/index.ts`](src/index.ts).

A backend that summarizes through `ctx.llm.stream()` must forward the abort signal into the call's `GenerateOptions.signal`, so an abort or fiber dispose tears down the in-flight summarization. Automatic and explicit-region brackets recover their numeric owner from the open turn; manual brackets require no open turn and stamp `turn: null`.

### Manual failure taxonomy

The synchronous `compaction/summary-error` waterfall lets a backend request durable input recovery for a failed summary and an explicit selection. A listener returns true only after recording progress, or calls `next()` to delegate. The backend checks cancellation and selection stability before dispatch, then re-derives and re-prices input before retrying. The event declaration documents its payload; image policy belongs to `dsh-compaction-image-offload`.

Expected manual failures throw `ManualCompactionError` with a stable `code` from a small closed set; only failures after the `compaction/start` marker are recorded — as a `compaction/end` carrying the error — while a `busy` rejection or pre-start cancellation leaves no record. The per-code semantics live in the [compaction subsystem reference](../../../docs/subsystems/compaction.md).

<a id="tool-pairing-boundaries"></a>
### Tool-pairing boundaries

The Service Definition exports `toolPairingBalancedBefore(session, seq)` and `toolPairingBalancedAfter(session, seq)` for snapping and validating compaction edges. A safe edge has no unanswered assistant tool call crossing it. Each helper validates that the event sequence is in the current surface and answers from balances cached per cut in surface order, so repeated checks read no events; a replace generation rebuilds the cache, and missing seqs or an orphan `tool/result` reject as corrupt surface state.

### The surface contract

`SurfaceEventType` is a closed union — `user/message`, `assistant/message`, and `tool/result` require `surfaceOp`, and other events forbid it, so a `compaction/*` event cannot appear on the surface. A successful backend run instead brackets the operation in the log: it appends `compaction/start` (log-only) to acquire the lock, summarizes the range, appends the log-only `compaction/summary` record, replaces the selected span with one `user/message` carrying the summary — the only surface mutation — and appends `compaction/end` (log-only) to release the lock.

The replacement sits inside the lock bracket, so a crash between `compaction/start` and `compaction/end` leaves a detectable orphaned lock rather than a `compaction/end` that falsely claims success. `deriveMessages()` renders the summary as a user-role message followed by the retained nodes; the shadowed events stay in the raw log, so replay is deterministic. The per-event payloads are enumerated in the [compaction subsystem reference](../../../docs/subsystems/compaction.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `CompactionEngine`, `CompactionTrigger`, `ManualCompactionError`, `ctx.compaction` merge |
| [`src/types.ts`](src/types.ts) | `CompactionResult` and the declaration-merged `compaction/*` session events |
| [`src/tool-pairing.ts`](src/tool-pairing.ts) | Per-session cut-balance cache behind the two boundary helpers |
| [`src/checkpoint.ts`](src/checkpoint.ts) | Cordis-free checkpoint source constructor and predicate (`./checkpoint` leaf) |
| [`src/brand.ts`](src/brand.ts) | `CompactionId` branded identity |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: validates the `compaction/start`→`summary`→`end` bracket, its owner-turn enclosure, and checkpoint correlation |

### Locking and serialization

One log-recorded lock is shared by all entry points. Tail inspection finds the latest unmatched `compaction/start` and the newest `session/end-seed`; an unmatched start after that boundary is live and reports `busy`, while an older one is stale evidence from a prior process lifecycle. A live bracket cannot cross a `turn/start` or `turn/end`. The markers are lock time points, not an exclusive container: an idle `inject()` may append unrelated context between a manual start and end, so the manual path revalidates its selected span rather than demanding whole-surface equality.

### Events

The `compaction/*` events extend `SessionEventMap` (merge-extensible) via declaration merging — session events, not Cordis `Events`, and all log-only. The generated [persistence log event catalog](../../../docs/persistence-catalog.md) owns the per-event payloads; `compaction/prune` documents the shadow-price protocol shared with the tool-result pruner.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared vocabulary to the shipped backend and the decision evidence.

- [Compaction subsystem reference](../../../docs/subsystems/compaction.md) — the condensation vocabulary, results, and generated service API.
- [Compaction basic backend](../compaction-basic/README.md) — the shipped backend that condenses automatically and on demand.
- [Tool-result pruner](../compaction-tool-result-pruner/README.md) — the optional companion that trims oversized tool outputs first.
- [Human /compact command](../command-compact/README.md) — the on-demand trigger for condensation.
- [Token meter](../../llm/token-meter/README.md) — the measurement service that decides when to condense.
- [Compaction capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) — the split and the session/llm dependency rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation history, when a backend is invoked

#### What the model sees

A successful backend replaces an older surface range with one user-role summary checkpoint — a `user/message` carrying `surfaceOp: { op: 'replace', startSeq, endSeq }`. The raw events stay logged but stop appearing in derived model messages; the seam itself performs no rewrite.

#### Token effect

Zero direct tokens from this Service Definition. A backend trades many retained history tokens for one summary and leaves the recent tail unchanged.

#### KV Cache effect

A successful backend replacement invalidates reuse from the first shadowed history token; the seam itself does not alter a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what condensation cannot do, regardless of which backend is loaded; they are the current package constraints.

- **Human command, not a model tool** — condensation is triggered by the `/compact` command and by automatic pressure; no model-facing compaction tool is registered.
- **Some single-unit overflow is out of contract** — balanced summary compaction cannot split one indivisible unit. The optional pruning companion can still repair a closed tool pair when text-bearing tool-result bulk is removable; a large non-tool node or a tool unit whose non-prunable remainder is oversized cannot be compacted.
- **An envelope that alone approaches the window is not surface-compaction work** — compaction shrinks derived history, never the system prompt, tools, or session prefix.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Model-facing tool, undecided** — compaction is human-command only. A model-facing compaction tool remains an open question; it would need its own schema and interaction with the existing command path.
- **Template and remote backends, undecided** — the `SummaryResult` contract already carries an unmarked `rawOutput` variant for summarizers that do not identify a call through `ctx.llm.stream()`, but no such backend ships.
- **Range arguments for `/compact`, undecided** — the argument-free form keeps behavior stable across command adapters; explicit ranges stay the programmatic `compactRegion()` path.

</details>
