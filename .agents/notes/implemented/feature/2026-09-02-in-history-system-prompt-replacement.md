# Agent Note: In-history system prompt replacement for cache-stable prompt changes

Status: implemented

English | [中文](2026-09-02-in-history-system-prompt-replacement.zh.md)

## Problem

Every system prompt change costs the whole provider prefix cache. The loop renders the prompt on every step; when the bytes differ — a plan-mode section entering or leaving, a skill or tool guidance section registering, an agent-scoped persona shadow, a changed `{{model}}` variable — the request's message 0 changes and the DeepSeek context cache misses from the first token. Long agentic sessions pay this repeatedly, and the [runtime-context snapshot design](../../archived/feature/2026-07-30-current-sandbox-policy-context.md) exists precisely because moving a changing fact out of the prompt was the only way to keep the prefix stable.

A DeepSeek model, recorded here as a model fact supplied for this work, removes that constraint: it accepts a `system` message at any position of the conversation and treats the latest one as the complete effective system prompt, replacing the leading one. Tool schemas remain part of the cached prefix; [dynamic tool updates](../architecture/2026-09-20-dynamic-tool-updates.md) can defer additions, while changed retained definitions still invalidate reuse. With that model the harness can append the new prompt after the cached history instead of rewriting message 0, and the prefix stays warm.

The harness has the representation for this because the [system prompt is surface node 0](../architecture/2026-09-02-system-prompt-as-surface-node.md): a prompt change is an operation on `system/message` surface nodes, and the choice between "replace the latest system node" and "append a new node" is a per-route decision.

## Decision

For a model route that declares the capability, the loop appends a new `system/message` surface node instead of replacing the latest system node when the rendered prompt changes and the prefix would otherwise survive. Everything else in the [surface-node decision](../architecture/2026-09-02-system-prompt-as-surface-node.md) is unchanged: the event type, the projection owner, the serializers, and the node 0 head protection.

### Capability

`dsh-llm` defines `SystemPromptUpdate = 'in-history'` and carries it as an optional sibling field, `systemPromptUpdate`, on `LlmResolvedModelInfo` and `PreparedLlmCall`; `normalizeModelInfo` rejects any other value with an `LlmError` whose code is `INVALID_MODEL_INFO`. The DeepSeek adapter's catalog model (`DeepSeekCatalogModel.systemPromptUpdate`, validated by zod at load) and the replay provider's `ReplayModelConfig.systemPromptUpdate` declare it per model; absence means the model needs message 0 rewritten. The sole built-in entry in `dsh-llm-deepseek`, `deepseek-flash`, declares it alongside text and image input. This exact catalog entry records the model capability; names and protocol families do not imply support for other models. A deployment can replace the catalog through the `models` list in `cordis.yml`, and every `dsh-llm-pi-ai` route keeps the replace behaviour.

The loop records the mode in the session: `RequestContext.systemPromptUpdate` joins provider, model, and capacity as a `request/context` field, logged whenever any of them differs from the latest snapshot. Admission reads `PreparedLlmCall.systemPromptUpdate` from the actual call prepared after `agent/request`; the preceding snapshot is not an admission input. First requests, resumed sessions, route changes, and same-route capability changes therefore use the capability of the bound adapter that will serve the call.

### The decision rule

`SystemPromptProjection.project(rendered, { inHistory, startsSeries })` in `packages/core/agent-loop/src/runtime-context.ts` scans the surviving `system/message` nodes of the current surface on every call. It returns ordered per-node commits. With no surviving system node it reserves the head even for an empty rendering. Effective text comes from the latest non-empty system node, falling back to the head; dormant empty tails neither supply effective text nor need another empty replacement. An empty rendering clears every active system node, regardless of route or series state. For a non-empty rendering on an incapable route or at a new request series, consolidation applies even when the effective text is unchanged. Otherwise matching effective text emits nothing. The operations are:

| Route capability | Prefix state | Operation |
|---|---|---|
| none | non-empty rendering, any prefix state | log an empty replacement for each non-empty later system node, then rewrite the first system node with the rendering if needed |
| `in-history` | the current request series continues | append a new `system/message` before the step's `user/message` events; the append alone needs no `request/header` |
| `in-history` | non-empty rendering, a new series starts | log empty replacements for non-empty later system nodes, then rewrite the first system node if needed, even when the latest effective text is unchanged |
| any | the rendered prompt is empty | log empty replacements for non-empty later system nodes, then empty the head if needed; no prompt version remains in derived messages |

`startsSeries` is true when the `agent/pre-step` decision declares `startsRequestSeries`, when the surface replace generation moved since the last request (a compaction or any other replacement), or when the visible tool-schema set changed on a route without `toolUpdate` support. Supported tool additions can accompany a prompt append without starting a series. A provider or model swap alone is not a series start for this rule: on a capable destination route the changed prompt is appended, which costs nothing because the route change already misses the cache. A series start already costs the cache, so consolidation keeps only the current prompt in model history. Logged per-node empty replacements remove later prompts from derived messages without a surface delete operation or any replacement of intervening conversation nodes. This also keeps compaction recovery from appending a system update after users already admitted by the failed attempt.

The first attempt admits the prompt after assembly, an accepted `agent/pre-step` decision, `step/start`, the `agent/request` waterfall, and `prepareCall()`. A rejected or empty first input opens no step. Neither async request phase commits the pending system prompt or accepted users, and cancellation during either commits neither. Every attempt synchronously reconciles the same rendered assembly after its own `agent/request` and `prepareCall()`, appends the accepted user batch only on the first attempt, logs header/context as needed, and derives and freezes the request before streaming through the same prepared call. Retries do not repeat assembly, `agent/pre-step`, or user admission. Reconciliation sees both pre-step compaction (`compaction-basic` with `auto: true`) and recovery compaction, and consolidates non-empty prompt text at the head when either starts a new series. Resume is series-continuing — the `resume` header is not a series start — so a prompt that changed across a restart is appended; the provider cache may still be warm across a process boundary.

An empty head with no active later system node represents no prompt. Dormant empty tails do not supply effective text, so repeated clearing and resume cannot resurrect an older prompt. Restoring non-empty text uses the same admission rule: a continuing capable route may append it; an incapable route or a new series refills the head. Clearing uses ordinary per-node replacements, not a surface delete or an initial empty-head creation.

### Presentation and accounting

Web presents an appended in-history node at its own position. `SystemPromptNode` carries `{ seq, time, turn, step, text, update }`, `update` being true for an appended `system/message` that follows an earlier system node in the loaded window. Chat renders a non-empty update as a collapsed `system-prompt` card titled by the locale key `message.systemPromptUpdate`, and a `request/header` in the same turn and step does not repeat the prompt card; `inspectRequestPrompt` reports no system change for a header that follows an update. Trajectory folds an update following a loaded request header into a synthetic request-header fact with `promptChange.kind = 'system'`, so later requests show the effective prompt without a real header change. When the loaded window lacks the earlier system node, the update is presented as an initial prompt. Transcript projections skip it like every `system/message`.

`dsh-token-meter` prices the last nonempty surviving system node in surface order as `contextBreakdown.systemTokens`; every other visible node, including superseded prompts, contributes to `messageTokens`. Empty dormant nodes are ignored. The sum equals the fixed-heuristic surface total after every replacement, whether or not a shadow-price claim exists. Compact retained entries reuse the measurement surface planner: state and transitions cost O(current retained surface), not O(1) or O(total historical log). Replaced entries and message bodies are discarded, and state version 4 rejects scalar checkpoints. `cacheReadTokens` on subsequent assistant usage remains the observable provider-cache effect.

Trajectory chooses the newer of the preceding real header and the preceding synthetic system header as the comparison state. A real header owns configuration and tools; an appended prompt can advance that state without another real header. Comparing only real headers would report A rather than B as the previous prompt for an A → B → C sequence.

Chat and Trajectory interpret the effective prompt through the pure `uiConversation.inspectSystemPrompt` operation. Each target keeps immutable prefix states for system events and positional replacements, with only surviving system nodes and a map of surviving replacement sequences to inherited surface positions. Each replacement copies that map and removes shadowed entries; historical prefix maps remain immutable. Ordinary appends and streaming updates require no prompt fold. Surface order, rather than event order or source-event citations, determines which nodes survive: a compaction can restore an older prompt without another system event, and a head rewrite can have a greater sequence than a later active prompt. Empty nodes remain addressable but do not override a nonempty prompt. An endpoint older than the earliest relevant loaded event has unknown order unless its replacement position is indexed. The interpreter withholds all subsequent prompt text after such an endpoint until prepend replay resolves the missing prefix; numeric event order cannot establish surface order. Historical cards keep their own prefix state rather than reading the final surface.

### Compaction

`compaction-basic` is unchanged. `selectCompactableRange` still anchors at the first non-system node, so node 0 is never shadowed and later in-history nodes can be; `buildSummarizationInput` prepends the derived head to `messages`, followed by every shadowed node's derived message in surface order, so a mid-region system node is replayed in place and the summarization call remains a genuine prefix of the conversation.

## Alternatives considered

**Send only the changed sections as a delta.** The model treats the latest system message as the complete prompt, so a delta would silently drop every unchanged section. Rejected on the model contract.

**Enable in-history mode by plugin config instead of a model capability.** A deployment flag could pair a non-capable model with appended system messages, which such a model would read as ordinary history at best. The capability belongs to the route that honours it; the adapter catalog already carries per-model capacities. Rejected.

**Always append, never re-baseline.** One rule, but node 0 would stay stale for the life of the session and every request after compaction would carry the stale head plus the replacement. Re-baselining at a series start costs nothing extra because the cache is already lost there. Rejected.

**Re-baseline on every resume.** Accepts one cache miss per process restart for a simpler resume path. The cache persists across restarts for hours to days, and the log already carries what resume needs. Rejected.

**Place the system message after the step's user messages.** Both positions sit after the cached prefix, but the model then reads the instructions after the input it must apply them to; system-before-user matches the leading position's ordering. Rejected.

**Project the prompt before the `agent/pre-step` waterfall.** The projection would not see a compaction performed inside the waterfall, so a just-appended node could be shadowed in the same step and the request would carry node 0's stale prompt as the only system message. Projecting after the waterfall keeps the rule a pure function of the surface the request is built from. Rejected.

**Use the preceding request context for admission.** It describes the previous call, not the adapter bound after request middleware. It can select the wrong prompt representation on the first call, after resume, or after a route or capability change. Resolving before prompt and user commits also keeps cancellation from admitting unsent content. Rejected.

**Treat a provider or model swap as a series start.** It would fold the prompt into node 0 on every route change, matching a tool change on an incapable route. The header already records the change and the cache misses either way, so the extra rule bought nothing but a special case in the loop. Rejected.

**Clear only the latest system node.** Empty nodes project to no message, so an older prompt would become effective again. Clearing all active versions preserves the meaning of an empty rendering without deleting conversation history. Rejected.

**Keep only scalar totals or prompt ancestry.** A scalar shadow price cannot identify which bucket lost the newest prompt or restore its predecessor. Prompt-only entries cannot locate arbitrary nonprompt replacement endpoints; `sourceEventSeqs` may also cite surviving prompts, and event sequence order differs from surface order after rewrites. Retaining compact current surface entries reuses the existing planner without full-log access, a second validator, or consumer-specific durable events. Summing all surviving prompts as system tokens would change the intended effective-prompt meaning rather than fix classification.

## Consequences

- A prompt change on a capable route keeps the provider prefix cache; the appended node costs its own tokens on every request in the series until compaction shadows it. A deployment whose prompt changes on most steps is better served by moving that fact into runtime context.
- The request head is not the only place a system prompt can live: readers of "what did the model see" fold the surface and take the latest system node, and the breakdown's system figure follows the same rule.
- A `request/context` snapshot records the prepared route and declared mode; it describes admission rather than deciding it. Incapable-route consolidation is logged per system node, preserving intervening user, assistant, and tool history.
- The model contract is recorded as supplied. If a released model narrows it — for example honouring only the latest system message within a bounded window — the rule needs a re-baseline trigger beyond series starts.
- A proxy that rewrites or reorders system messages breaks the replacement semantics silently; the real-API e2e's cache-hit assertion is the detector.

## Testing

Lifecycle verification requires no event for an unchanged prompt and an appended changed prompt after resume on a capable route. Both TypeScript and Python SDK expected outputs must include the typed appended `system/message` event, as required by the [SDK snapshot policy](../../../../docs/testing.md). The [TypeScript SDK notifications](../../../../snapshots/sdk/system-prompt-in-history/notifications.expected.jsonl) and [Python SDK prompt history](../../../../scripts/snapshots/python-sdk-single-exe/minimal-in-history/prompt-history.json) record the appended prompt event and retained prompt versions.

- `packages/core/agent-loop/tests/system-prompt-admission.spec.ts` covers capable-to-incapable routing with changed or unchanged text, incapable-to-capable routing, resumed-route admission, cancellation in request middleware or preparation, and a concurrent selection change while the prepared route stays bound. Retry-compaction cases shadow the latest prompt with or without an earlier surviving update and verify reuse of the admitted assembly, one user admission, and no extra series header on an unchanged retry. Clear cases on capable and incapable routes remove three active prompt versions, keep repeated requests and seeded resume empty without extra prompt events, and restore only the new text; log reconstruction and the pi converter retain no old instructions. Focused coverage of `src/agent.ts` and `src/runtime-context.ts` reaches 100% for statements, branches, functions, and lines.
- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` pins the append on a continuing series, the re-baseline at a series start with or without surviving later nodes and with changed or unchanged effective text, the empty-prompt clearing of all active versions, and the replace-only behaviour without the capability.
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` pins the appended node under an inherited header with `request/context` carrying `systemPromptUpdate`, the series-start fold into node 0, the compaction-driven re-baseline, and the tool-schema change re-baseline on a route without `toolUpdate`, under a `change` header that starts a series.
- `packages/llm/llm/tests/service.spec.ts`, `packages/llm/llm-deepseek/tests/adapter.spec.ts`, and `packages/test-support/llm-replay/tests/llm-replay.spec.ts` pin the declared mode on resolved model info and the load-time rejection of any other value.
- `packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` pins newest/middle prompt removal, exact heuristic totals, surface ordering after head rewrites, extra source-event citations, dormant empties and fallback clears, immutable transitions, compact retained checkpoints, late registration, replay, and version invalidation.
- `packages/client/ui-conversation`, `ui-chat`, and `ui-trajectory` client specs pin the update card, the same-step header dedupe, the absent system change after an update, and the synthetic trajectory header.
- The keyless authored snapshot `snapshots/session/system-prompt-in-history/` declares the capability on the replay route, changes the prompt after the first tool call through a fixture section, and pins the appended `system/message`, the untouched node 0, the single `request/header`, and the `request/context` mode.
- `packages/llm/llm-deepseek/tests/adapter.e2e.ts` runs a two-step prompt change against the model named by `DEEPSEEK_IN_HISTORY_MODEL`, asserts that the reply follows the appended prompt, and asserts that the appended request reads more cached tokens than the same conversation with a rewritten leading prompt; it skips when the variable is unset.
