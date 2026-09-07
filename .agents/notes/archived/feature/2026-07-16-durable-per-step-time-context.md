# Agent Note: Durable per-step time context

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-16-durable-per-step-time-context.zh.md)

## Problem

A request-only clock can tell the model the current time, but replacing that value in the system prompt removes the evidence behind earlier time-sensitive reasoning. Multi-step turns need requests to retain the readings used by preceding steps. The request must remain reconstructable after restart, and automatic compaction must account for the same timing context the model receives.

A process-local refresh cache makes displayed time depend on state that cannot survive resume. Browser-originated natural language also needs a request-owned zone: a server process zone cannot infer the user's locality, while a mutable Session or connection default lets travel or concurrent tabs reinterpret another prompt.

## Decision

`@deepseek-ai/dsh-time-context` is an opt-in function plugin in `packages/context/time-context/`. Default compositions leave its disclosure and token cost disabled; the Schedule Web overlay mounts it so the model can interpret otherwise-unqualified dates and times in the browser zone attached to the current request.

The plugin prepends an `agent/pre-step` listener and delegates first. When the downstream decision enters and a reading is due, it combines that decision's final messages with durable user messages already in the open turn, derives browser-zone provenance from exact `user-rpc` sources, and appends one reading to the decision. Rejection, listener failure, or an already-aborted signal records nothing. Steering claimed after the current batch keeps ordinary next-step ownership and receives a fresh reading when that step enters.

Each Web prompt samples the browser's IANA zone. The Host validates and canonicalizes it before binding it to the exact durable user-message source. One unique zone in the open turn resolves the request; multiple zones produce a sorted `mixed` result; no zone is `unavailable`. A resolved request tells the model to interpret unqualified dates and times in that zone. Mixed or unavailable provenance tells it to ask the user to clarify.

This message-bound provenance is not copied to `SessionHeader`, a connection default, or Schedule state. Time-context owns model guidance only. A tool accepting local calendar fields must still make its own explicit boundary; Schedule therefore requires `time_zone` rather than importing this plugin's reading ([decision](../simplification/2026-08-09-explicit-schedule-time-zone.md)).

The resolved browser zone also formats the reading's timestamp. Mixed or unavailable requests use the configured `timeZone` fallback, or the Node process zone resolved once at plugin load when config is omitted, while retaining the clarify policy. Every fallback is validated through `Intl.DateTimeFormat`.

Each reading uses the exact snapshot source `{ kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: <same text> }] }`. The invariant companion checks the snapshot shape, re-derives current-turn browser provenance from the original user-rpc messages, and validates the rendered timestamp zone and elapsed baseline.

The optional `refreshIntervalMs` config is a non-negative safe integer. Omission or `0` injects on every eligible entered step. A positive value scans raw Session events for the latest plugin reading and injects when none exists, wall time moved backward, or the event is old enough. The event timestamp governs after compaction and resume without a process-local cache. The Schedule Web overlay omits the interval so every request step gets current browser guidance.

### Text and elapsed baselines

A resolved first-step reading is:

```text
Time sampled while preparing turn <turn>, step 1: <timestamp-in-browser-zone>
Browser time zone for this request: <iana-zone>. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

Mixed and unavailable variants replace the second line with an instruction to ask for clarification. The baseline is the latest durable preceding user, assistant, or tool-result message. The prompt proposed for this step has not been appended yet; a new Session can therefore report `unavailable`.

A later-step reading changes the first line's step number and ends with:

```text
Elapsed since the preceding step context: <duration-or-unavailable>.
```

That baseline is the preceding time-context event in the open turn. Missing baselines report `unavailable`; duration formatting uses compact whole-second units and clamps backward wall-clock movement to zero.

### Durability and reconstruction

An entered step appends its returned messages followed by the time reading after `step/start`, before request derivation. A later preparation failure can leave the reading in history because it records entry, not successful transmission. Each reading remains a normal surface node until compaction shadows it. A positive interval can let a later request reuse existing history without adding a fresh reading.

The plugin contributes nothing to system-prompt assembly or `request/header`. Request reconstruction obtains the complete durable surface prefix at each `step/start`, so historical requests recover the exact time and browser policy the model saw.

## Alternatives considered

- **Replace a dynamic system-prompt value** — rejected because replacement erases prior readings and changes reconstructed historical requests.
- **Persist a Session default zone** — rejected because the browser fact belongs to one prompt; travel and concurrent tabs must not mutate shared meaning or spread zone state through Session, fork, and persistence contracts.
- **Copy the browser zone into a second context authority** — rejected because the original user-rpc source already owns it and the invariant can re-derive policy directly.
- **Let Schedule consume the reading implicitly** — rejected because prose context is not a stable typed default and would couple an absolute-time parser to AgentLoop history. The model instead passes an explicit offset or zone.
- **Use only the process zone** — rejected because deployment locality cannot infer a remote user's zone. It remains a display fallback when request provenance is absent or mixed.
- **Expose time only through a tool** — rejected because ordinary temporal reasoning would require an avoidable round trip and would not ensure a reading before each step.
- **Mount time-context by default** — rejected because disclosure, freshness, and history cost remain composition policy.

## Verification

Unit and real-loop tests pin timestamp formatting, unique/mixed/missing browser derivation, fallback display, both elapsed baselines, interval boundaries, cross-turn and resumed scheduling, backward-clock behavior, steering ownership, cancellation, exact snapshot validation, and request reconstruction. Host/client tests pin browser sampling plus validation and canonicalization at prompt entry. The keyless assembled Schedule Web scenario sends a real browser prompt, observes the same zone in the model request, and verifies that the model supplies it explicitly to `schedule_create`.

## Consequences

- Browser-zone meaning is request-local and durable without changing Session, fork, or JSONL schemas.
- The model receives the requested browser-local assumption on each Schedule Web request step; mixed or missing provenance asks instead of guessing.
- Tools remain explicit: context helps the model choose fields but does not become a hidden package-seam default.
- Timing context remains append-only until compaction; a positive interval reduces history growth but can omit fresh browser guidance on later requests.
