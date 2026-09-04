# Agent Note: Every LLM request is reconstructable from the session log

Status: implemented

English | [中文](2026-07-05-reconstructable-requests.zh.md)

## Problem

The request pipeline did not guarantee prefix stability for provider caching, and the session log could not reconstruct what the model saw. It omitted model, system prompt, and tool schemas while allowing per-call request rewrites. Cache behavior and replay equivalence therefore depended on whichever plugins happened to be loaded.

The reference shape for the happy path is MiniCode's `LLMClient`: a stateful conversation client, appended to — never rebuilt — as the conversation advances, resetting only when the system prompt, tool set, or compaction genuinely changes what the model must see. The design question this Agent Note answers is how to get that discipline without giving up event-sourcing.

## Decision

### The principle

**Model-visible ⟺ durably referenced.** Anything that reaches a model request must be reconstructable from the session log and the immutable content-addressed objects it references. The checkable consequence: anyone holding the log, its referenced attachment objects, and the pinned code version reconstructs every loop request byte-for-byte. Text-only `GenerateOptions` remain a pure function of the log; image-bearing requests additionally resolve `ImageAttachmentRef` bytes through `ctx.attachments` during adapter serialization, where digest and recorded metadata verification make the object lookup deterministic and fail loud on missing or corrupt data. Direct one-shots (compaction's summarize call) log their envelope scalars (`compaction/summary.{provider, model, maxTokens}`), and their input is deterministic code over the logged region plus those referenced objects — outside the invariant because only the loop marks request ownership.

Prefix-cache stability is corollary #1, not the headline: an append-only log projected by a per-node pure function yields requests that are append-extensions of their predecessors whenever the header is unchanged — stability is emergent, not managed. Byte-exact audit/replay is corollary #2; resume and fork with *attributable* drift is corollary #3.

### The mechanism

**Messages.** `Session.deriveMessages()` is cached: each surface entry is projected exactly once, when first seen, through the public per-event function `deriveEventMessage(event)`; a surface rewrite (a compaction `replace` — `SurfaceManager.replaceGeneration`) rebuilds. Callers get a fresh array per call over shared, deep-frozen messages: mutating logged history through a projection is unrepresentable (it throws), replacing the old clone-per-call isolation. External reconstructors fold the same public function over a log prefix, so no two paths can disagree.

`EpochHeader` records the request's non-history state: call config, rendered system prompt, and tool schemas, with empty values canonicalized to absence. Adapter-supplied effort and token defaults retain their `adapterDefaults` provenance; a Web model selection restored from the log omits an adapter-owned effort so the next resolution cannot reclassify the same effective config as an explicit selection and a false change. `request/header` always writes a full snapshot: the first loop instance uses reason `initial`, later instances use `resume`, an in-instance change uses `change`, and an unchanged envelope beginning an explicitly declared message series or following a surface replacement uses `series`. A `change` snapshot carries `startsSeries: true` when the changed request also starts a series, preserving the two independent facts without a duplicate header. Ordinary append-only later Turns, further same-series Steps, and retries inherit the latest snapshot. `foldRequestHeader` selects the latest snapshot. Legacy `request/header-delta` events and the removed `fallback` reason are rejected when appended or loaded.

Each proposed step first claims its inbox batch and runs `agent/pre-step`. Rejection opens no step; enter opens `step/start`, records the final message batch as `user/message` events, and may use `startsRequestSeries: true` to declare a distinct series. The step then assembles the system prompt and tools, while `agent/request` may replace only the frozen call-config seed. The loop records the owed initial, resume, change, or series full snapshot, builds `GenerateOptions` from derived messages and that header, and deep-freezes it while leaving `AbortSignal` live. The first call config starts from explicit `AgentOptions`, preserving fork overrides and resume reconfiguration; later calls start from the folded header.

**The open step is the reconstruction boundary.** Its entered `user/message` batch and any newly written `request/header` precede request dispatch. Injection after the atomic claim joins a later request, while a listener that must affect this request returns messages through `agent/pre-step`. Header reconstruction selects the step's `request/header`, or carries the prior snapshot when no new header is written.

**Enforcement.** The `dsh-agent-loop/invariant` companion registers with `ctx.invariants` and, when selected, independently rebuilds each loop request through a fresh `Session`, so the live cache cannot vouch for itself, then compares messages and folded header fields at `llm/stream`. The loop records the exact frozen request through `markAgentLoopRequest()` in `dsh-llm`; the process-local identity lets the companion and other request observers recognize conversation work, while direct one-shots remain excluded regardless of their frozen shape or session id. Correctness depends on sequence-bounded reconstruction rather than listener order. A with-key e2e requires positive cache-read tokens after the first request; per-step usage is the production signal, and a header change or compaction appears as a cache-read drop on the next step.

### The MiniCode shape: adopted, with the event log as the source

Like MiniCode, the conversation advances append-only and resets only when model-visible state changes. Unlike MiniCode, the event log remains the source of truth because it also owns persistence, recovery, boundaries, tool pairing, and links from derived events to their inputs. `Session` caches message and header folds derived from that log, making every request independently checkable.

## Alternatives considered

- **Client as source of truth** (literal MiniCode): a second operative truth beside the log — the two drift and nothing notices; see the section above.
- **A stateful transmission client mirroring the log** — duplicates conversation state, needs rollback around listeners, leaves an unlogged edit path, and still cannot reconstruct request headers. Session-owned caches plus logged headers avoid those split truths.
- **Per-call request scalars** (a freely mutable config handed to each `agent/request` dispatch): a listener flips the model per call with zero accounting, silently abandoning the provider cache this design exists to protect. Config is per-conversation logged state; the waterfall proposes, the log records.
- **Detect-and-report** (compare consecutive requests, warn on divergence): catches violations after the fact; a violating request is still constructible and ships. Rejected for interface-level unrepresentability.
- **Event-driven assembly** (re-render only on change signals): a missed-signal bug class — a tool registered mid-session emits `tools/change`, not `system-prompt/change`, and a third-party provider may emit nothing. Per-step render + value compare is robust with zero signal discipline.
- **A custom header-delta codec** (system line edits, name-keyed tool edits, whole config/prefix replacements): reduced repeated bytes but duplicated the representation and its diff/apply/fallback machinery. Full snapshots retain one replay representation.
- **A lightweight series marker referencing the previous header**: reduced repeated prompt and tool bytes, but a window beginning at that marker could not render or reconstruct the request without fetching its predecessor. A self-contained full snapshot preserves one representation for persistence, partial history, and snapshot pinning.
- **Narrative changed-field lists on header snapshots**: derivable by comparing consecutive snapshots. The `reason` remains because an instance boundary is not derivable from the snapshot values.

## Consequences

- A request that is not explained by the log cannot be constructed by accident — not by the loop, not by a listener; mutating a built request throws; every header change is a durable, diffable log event.
- Model-visible context uses logged message channels. `agent.inject()` and tool `additionalContexts` enter the inbox for a later claim, while `agent/pre-step` returns context that must settle with the current claimed batch. Each entered value is a durable sourced `user/message`, paid once and prefix-cached thereafter at the price of accumulating in history until compaction.
- What still costs full price at the provider is inherent and logged: compaction (its `compaction/*` events and replacement entry), a real prompt, tool, or config change (`request/header` with reason `change`), or a process boundary with drift (a differing `resume` snapshot). The provider's own reasoning-content exclusion is managed server-side.
- `agent/pre-step` is the current-request message channel; direct inbox mutation is the eventual later-request channel.
- Tool-result trimming needs no new mechanism: a logged single-entry surface replace (`start === end`) carrying a trimmed `tool/result` under the same `callId` — compaction-family, replay-correct, cache-bust batched by the same pressure logic.
- Unreadable referenced attachment objects still fail model requests; [automatic attachment quarantine](../../proposed/bug-fix/2026-08-20-attachment-read-quarantine.md) records the proposed recovery without weakening byte-exact reconstruction.
- Session logs grow one `request/header` snapshot per loop instance, real change, and later model-message series. Repeating the full system prompt and tool catalog is larger than a delta codec but small beside chunk-heavy logs and retains one self-contained replay representation. Current v1 retains this single representation; the frozen v0-to-v1 edge explicitly refuses legacy delta events before current Session construction.
- Snapshot fixtures include each repeated series header. Keyless refresh owns those deterministic log changes, while the snapshot harness pins prompt and tool sidecars only for the initial and actual change revisions and reuses the current revision for `series` snapshots. Filesystem-writing fixtures remain in normalized authored form with cwd-relative tool arguments because replay only round-trips cwd-independent argument paths.
