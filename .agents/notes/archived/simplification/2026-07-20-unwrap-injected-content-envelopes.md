# Agent Note: Project injected content verbatim, dropping the XML envelopes

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-20-unwrap-injected-content-envelopes.zh.md)

## Problem

Two families of injected session content rendered into the model transcript wrapped in XML envelopes: `steering/message` as `<steering source="…">…</steering>` and `context/message` as `<context source="…">…</context>` (the latter with a `'raw'` opt-out that skipped the wrapper). The envelopes aimed to tell the model "this is injected, not the user speaking."

Two problems:

- **No model is trained on these tags.** `<steering>` and `<context>` are arbitrary markup no model was taught to read, so the framing adds tokens without a reliable effect and can actively mislead — recorded transcripts show a model treating a `<steering>` instruction as third-party metadata and refusing it while answering only the original prompt.
- **The session surface is the wrong layer for framing.** The surface projects the durable log into the model transcript; deciding how content is worded is not its job. A caller that wants a particular frame formats its own content before injecting it — which the one heavy producer (`agent-instructions`) already does, owning its complete `<system-reminder>` frame and opting out of the `<context>` wrapper with `envelope: 'raw'`. The remaining tag machinery (`ContextEnvelope`, an `envelope` field threaded through `InjectOptions`, `HookContext`, the `context/message` event, and the loop) served a distinction that belongs to the caller.

## Decision

Injected session content projects verbatim; the caller owns any framing. `deriveEventMessage` renders `user/message` content blocks to the model unchanged; `source` stays in the durable event log but does not render.

The `ContextEnvelope` type and every `envelope` field are removed — `context/message` in `SessionEventMap`, `InjectOptions`, `HookContext`, and the `inject()`/`additionalContexts` plumbing in `dsh-agent-loop`. `agent-instructions` no longer requests `'raw'`; its self-framed content renders as before. The `renderTagged`/`renderContextEnvelope` helpers are deleted. `context/message.meta` still carries durable, model-hidden JSON state.

The `source` attribution remains on the durable events and is omitted from the transcript.

## Alternatives considered

- **Keep the `<context>` envelope, unwrap only steering** — leaves the `ContextEnvelope`/`envelope` machinery alive for a framing bit no model reads, and keeps the inconsistency that the main producer already opts out of.
- **Keep the envelope field for plugin-sourced content only** — splits one projection into two on `source.kind` for no observed benefit; a plugin steering the agent (hook-bridge continuation reasons) also wants the instruction followed, not labeled.
- **Move the unwrapping into adapters** — the canonical projection is the model-visible contract ("model-visible ⟺ logged"); per-adapter divergence on framing would make the derived transcript adapter-dependent. Framing that a caller genuinely wants belongs in the caller's content, not in an adapter.

## Consequences

- Mid-turn steering and injected context reach the model with the same weight as an ordinary user prompt.
- The transcript no longer distinguishes injected content from a user message; consumers that need the distinction read the durable event log, which keeps the event types, `source`, and `meta` intact.
- The `hook-{cc,codex}-stop-continue` ACP snapshots were re-recorded: the old recordings captured the model refusing steering as third-party metadata, the fix's exact failure mode.
- The [content-block-vocabulary Agent Note](../architecture/2026-06-11-content-block-vocabulary.md)'s tagged-envelope clause is amended to point here.

## Deferred

`agent-instructions` already frames its own content: it emits a complete `<system-reminder>…</system-reminder>` block as the message content instead of leaning on a surface-level wrapper. That caller-owned pattern is the one to keep — the surface passes content through verbatim, and any framing lives in the producer's own content.

Two framing paths existed — caller-baked framing (`agent-instructions`'s `<system-reminder>`) and surface-level wrapping (`<context>`/`<steering>` added by `deriveEventMessage`). This change removes the second, leaving only caller-owned framing. If labeled framing is wanted again, unify it through the event's `meta` map — the producer-attached, model-hidden metadata field — consumed by a dedicated renderer or adapter, rather than re-hardcoding a tag in `deriveEventMessage`. A producer declares the frame it wants in `meta`; one renderer applies it; the session-surface projection stays a verbatim pass-through.
