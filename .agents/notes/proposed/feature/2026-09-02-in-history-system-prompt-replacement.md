# Agent Note: In-history system prompt replacement for cache-stable prompt changes

Status: proposed

English | [中文](2026-09-02-in-history-system-prompt-replacement.zh.md)

## Problem

Every system prompt change costs the whole provider prefix cache. The loop renders the prompt on every step; when the bytes differ — a plan-mode section entering or leaving, a skill or tool guidance section registering, an agent-scoped persona shadow, a changed `{{model}}` variable — the request's message 0 changes and the DeepSeek context cache misses from the first token. Long agentic sessions pay this repeatedly, and the [runtime-context snapshot design](../../archived/feature/2026-07-30-current-sandbox-policy-context.md) exists precisely because moving a changing fact out of the prompt was the only way to keep the prefix stable.

A DeepSeek model, provided as an unpublished model fact for this proposal, removes that constraint: it accepts a `system` message at any position of the conversation and treats the latest one as the complete effective system prompt, replacing the leading one. Tool schemas remain part of the cached prefix, so a tool-set change still invalidates the cache. With that model the harness can append the new prompt after the cached history instead of rewriting message 0, and the prefix stays warm.

The harness has the representation for this only after the [system prompt is surface node 0](../architecture/2026-09-02-system-prompt-as-surface-node.md): a prompt change is then an operation on `system/message` surface nodes, and the choice between "replace node 0" and "append a new node" is a per-model decision.

## Proposal

For a model route that declares the capability, the loop appends a new `system/message` surface node instead of replacing node 0 when the rendered prompt changes and the prefix would otherwise survive. Everything else in the [surface-node design](../architecture/2026-09-02-system-prompt-as-surface-node.md) is unchanged: the event type, the projection owner, the serializers, and the presentation.

### Capability

The DeepSeek adapter's catalog model gains a validated optional field, `systemPromptUpdate`, with the single accepted value `'in-history'`; absence means the model needs message 0 rewritten. The adapter surfaces it on `LlmResolvedModelInfo` and `prepareCall()` returns it beside `context.contextWindow`, so the loop reads it from the same registration-bound metadata it already consumes. No default catalog entry declares it until the model is released; a deployment enables it through the `models` list in `cordis.yml`. Models without the field — including every current default entry and every `dsh-llm-pi-ai` route — keep the replace-node-0 behaviour exactly.

### The decision rule

`SystemPromptProjection` tracks the **effective prompt**: the text of the latest surviving `system/message` on the surface (node 0 when no later system node exists). When the rendered prompt differs from the effective prompt:

| Route capability | Prefix state | Operation |
|---|---|---|
| none | any | replace node 0 |
| `in-history` | the current request series continues (no compaction since the last request, no tools or config change) | append a new `system/message` before the step's `user/message` events |
| `in-history` | a new series starts (compaction replaced the surface, or `request/header` records a `change` for tools or config) and no mid-history system node survives | replace node 0 with the current prompt |
| `in-history` | a new series starts but a mid-history system node survives | append a new `system/message`; node 0 stays as it is |

The third row exists because a series start already costs the cache; folding the prompt back into node 0 keeps the history short. The fourth row exists because the surface has no delete operation: replacing node 0 while a later system node survives would leave the model reading the later, stale node as authoritative, so the loop appends instead. In-history mode never rewrites node 0 while any later system node survives.

Resume follows the mid-session rule. A new loop instance restores the effective prompt from the log and, when the freshly rendered prompt differs, appends — the provider cache may still be warm across a process boundary, and the `resume` header is not a series start.

### Presentation and accounting

A mid-history `system/message` uses the same collapsed request-prompt inspection card as node 0, labelled as a prompt update at its position in the request; it is never a chat bubble, transcript projections skip it, and SDK projections expose it as a typed event. `dsh-token-meter` prices it like any other surface node, so the per-step context breakdown shows the accumulated cost of retained prompt versions until compaction shadows them. `cacheReadTokens` on the following `assistant/message` usage is the observable effect: for a capable route the value covers the prefix through the last cached message; for a non-capable route it drops to the shared-prefix detection floor.

### Verification plan

- Unit tests in `dsh-agent-loop` for the projection: append on a mid-series change, replace on a series start without surviving mid-history nodes, append on a series start with one, append on resume, no operation when unchanged, and replace-only behaviour for a route without the capability.
- Unit tests in `dsh-llm-deepseek` for catalog validation (`systemPromptUpdate` accepts `'in-history'` only) and for `prepareCall()` surfacing the field.
- A keyless recorded snapshot under `snapshots/` whose composition declares the capability on the mock route and toggles plan mode mid-session, pinning the appended `system/message` and the untouched node 0; TypeScript and Python SDK expected outputs include the appended event.
- A real-API e2e that runs two steps with a prompt change against a capable route and asserts that the second request's `cacheReadTokens` is at least the first request's prompt token count. It resolves its route from the standard credential and base-URL mechanism and self-skips when no capable route is configured.

## Alternatives considered

**Send only the changed sections as a delta.** The model treats the latest system message as the complete prompt, so a delta would silently drop every unchanged section. Rejected on the model contract.

**Enable in-history mode by plugin config instead of a model capability.** A deployment flag could pair a non-capable model with appended system messages, which such a model would read as ordinary history at best. The capability belongs to the route that honours it; the adapter catalog already carries per-model capacities. Rejected.

**Always append, never re-baseline.** One rule, but node 0 would stay stale for the life of the session and every request after compaction would carry the stale head plus the replacement. Re-baselining at a series start costs nothing extra because the cache is already lost there. Rejected.

**Re-baseline on every resume.** Accepts one cache miss per process restart for a simpler resume path. The cache persists across restarts for hours to days, and the log already carries what resume needs. Rejected.

**Place the system message after the step's user messages.** Both positions sit after the cached prefix, but the model then reads the instructions after the input it must apply them to; system-before-user matches the leading position's ordering. Rejected.

## Acceptance criteria

- `DeepSeekCatalogModel.systemPromptUpdate` is validated at load, exposed through `LlmResolvedModelInfo`, and returned by `prepareCall()`; a misspelt value fails at load.
- On a capable route a mid-series prompt change appends `system/message` before the step's `user/message` events and node 0 is unchanged; on a non-capable route the same change replaces node 0.
- On a capable route a series start with no surviving mid-history system node replaces node 0; with a surviving one it appends.
- A resumed loop instance whose rendered prompt differs appends on a capable route.
- The recorded snapshot and both SDK expected outputs pin the appended event; the e2e asserts the cache-hit inequality when a capable route is configured and skips otherwise.
- The `dsh-llm-deepseek`, `dsh-agent-loop`, and `dsh-system-prompt` READMEs document the capability, the decision rule, and the KV Cache effect; `docs/config-catalog.md` lists the field.

## Risks

- The model contract is unpublished; the note records it as provided. If the released model narrows it (for example, honouring only the latest system message within a bounded window), the decision rule needs a re-baseline trigger beyond series starts.
- Retained prompt versions accumulate in history until compaction shadows them. Each version costs its tokens on every request in the series; a deployment whose prompt changes on most steps would be better served by moving that fact into runtime context.
- A proxy that rewrites or reorders system messages breaks the replacement semantics silently; the e2e's cache-hit assertion is the detector.
