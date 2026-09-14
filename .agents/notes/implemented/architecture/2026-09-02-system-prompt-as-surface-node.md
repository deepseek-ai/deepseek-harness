# Agent Note: The system prompt is surface node 0

Status: implemented

English | [中文](2026-09-02-system-prompt-as-surface-node.zh.md)

## Problem

A system prompt held outside the surface has a different durable representation from every other message the model reads. Conversation messages are surface events (`user/message`, `assistant/message`, `tool/result`) folded in seq order by `Session.deriveMessages()`; a prompt stored as a `system` field of the log-only `request/header` snapshot has to be prepended by each serializer as wire message 0. The [reconstructable-requests Agent Note](2026-07-05-reconstructable-requests.md) made both halves durable, but that layout leaves one model-visible fact with two homes: the surface owns the messages, the header owns the message in front of them.

That split forces every reader of "what did the model see" to join two sources: the compaction summarizer copies the header prompt in front of the region's derived messages, `dsh-token-meter` estimates the system prompt from the header while pricing every other message from the surface, and the Web request-prompt card, the trajectory view, and the snapshot normalizer's `{{system}}` placeholder each read the header on their own. Change detection is split the same way: a `headerEquals` that compares `system` byte-for-byte beside `config` and `tools` makes a prompt change and a tool change indistinguishable in the log (`request/header` reason `change`) even though they are different operations on the conversation.

The split also blocks the next step. A model that accepts a mid-conversation `system` message as a prompt replacement needs the harness to append a system-role message to history; with the prompt living in the header there is no surface representation to append, and the header would have to be frozen by special case. The [in-history replacement decision](../feature/2026-09-02-in-history-system-prompt-replacement.md) depends on this note.

## Decision

The system prompt lives on the surface. It is an ordinary surface event, `system/message`, and every prompt lifecycle operation is one of the two existing `SurfaceOp` variants applied to that event type. The wire request is unchanged: the surface fold yields the message list the serializers send, with the system message first.

### The event

`system/message` is a member of `SurfaceEventType` beside `user/message`, `assistant/message`, and `tool/result` (`packages/core/session/src/types.ts`). Its payload mirrors `tool/result`: `{ turn, step, message }`, where `message` is a `SystemMessage` with `role: 'system'`, one text block holding the rendered prompt, and source `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`. Empty `content` records "no system prompt": the node keeps its surface position and `deriveEventMessage` projects it to `null`, so it contributes no wire message. A non-empty node projects verbatim, so `deriveMessages()` returns the system message at its surface position and the DeepSeek serializers, which pass a `role: 'system'` history message through unchanged, emit it as wire message 0. `EpochHeader` is `{ config, adapterDefaults?, tools? }`; `canonicalHeader` and `headerEquals` in `packages/core/session/src/request-header.ts` compare config, adapter defaults, and tools only.

### The operations

| Situation | Surface operation |
|---|---|
| No `system/message` survives on the surface (including an empty rendered prompt) | append `system/message`; on the session's first step it is surface node 0, before the first `user/message` of the step |
| A `system/message` survives and the rendered prompt differs from its text (including a prompt that becomes empty) | replace exactly that node: `surfaceOp: { op: 'replace', startSeq: <seq of the node>, endSeq: <same> }`, `sourceEventSeqs: [<seq of the node>]`; an empty prompt produces an empty-content node that projects to no message |
| The rendered prompt equals the surviving node's text | no operation |

When the initial rendered prompt is empty, the loop reserves an empty system head before the initial admitted user messages so a prompt that first becomes non-empty later still replaces node 0. Omitting that empty node would append the later prompt behind user history, where pi-ai converts it to a user message rather than its `systemPrompt`. Replacing node 0 is a head rewrite expressed on the surface: the provider prefix changes from the first token, the log records the shadowed node through `sourceEventSeqs`, and `replaceGeneration` advances as it does for a compaction replacement. The loop's `startsSeries` detection (`requestSurfaceGeneration !== surfaceGeneration`) therefore covers the prompt change without a `system` comparison in `headerEquals`. `request/header` keeps reasons `initial`, `resume`, `change`, and `series`; `change` means config or tools changed, and the unchanged header that follows a prompt replacement logs as `series`.

`packages/core/session/src/surface.ts` enforces the head invariant in `assertSystemHeadRewrite`: a replacement whose range covers surface node 0 while node 0 is a `system/message` is rejected unless the replacing event is itself a `system/message` covering exactly that node. System nodes at later positions carry no such protection; a compaction range may shadow them.

### Ownership in the loop

`dsh-agent-loop` owns `SystemPromptProjection` beside `RuntimeContextProjection` in `packages/core/agent-loop/src/runtime-context.ts`. It reads the surviving `system/message` nodes from the current surface on every projection, so a compaction or replacement that ran earlier in the same step is already reflected. `project(rendered, { inHistory, startsSeries })` returns `{ message, intent }` — `intent` is `{ surfaceOp: 'append' }` when no system node survives or when the [in-history rule](../feature/2026-09-02-in-history-system-prompt-replacement.md) applies, otherwise a replacement of exactly the latest surviving system node — or `undefined` when the latest node already holds the rendered text.

In `packages/core/agent-loop/src/agent.ts`, `preStep` renders the prompt with `renderPrompt(assembly)` and projects it after the `agent/pre-step` waterfall, so a compaction provider's replacement inside that waterfall is visible to the decision; `turn()` commits the `system/message` immediately after `step/start` and before the step's `user/message` events, so log order is wire order. `buildRequest` sets no `system` on the request: the request is `header.config`, `session.deriveMessages()` (system message first), and `header.tools`. The loop step order is: claim inbox → `systemPrompt.assemble()` → project runtime context → `agent/pre-step` waterfall → project system prompt → `step/start` → commit `system/message` (when changed) → commit `user/message`s → `agent/request` waterfall → `request/header` → `request/context` → stream. The `dsh-agent-loop/invariant` companion (`packages/core/agent-loop/src/invariant.ts`) asserts that a loop-built request has `system === undefined` and `messages` equal to `deriveMessages()`.

`dsh-token-meter` anchors usage to the priced surface immediately before the successful `assistant/message`, not to `step/start`. The loop admits the system prompt and user messages after step start, and retry recovery can replace nodes before rebuilding the request. Capturing that current surface includes every admitted input once; the embedded provider output remains separately priced so durable assistant rewrites retain their signed delta. The open step stores only turn and step for lifecycle validation, not a second node snapshot.

### Consumers

| Consumer | Reads |
|---|---|
| DeepSeek serializers (`serializeRequest`, `serializeRequestWithImages`) | `options.messages`, passing the `role: 'system'` history message through as wire message 0; `GenerateOptions.system` remains for direct one-shot callers such as title providers |
| `dsh-llm-pi-ai` | a leading system history message maps to pi-ai's `systemPrompt` |
| `compaction-basic` `buildSummarizationInput` | node 0's derived message prepended to the region in `SummarizationInput.messages`, with no separate `system` field; an empty-content head projects to no message while staying protected from compaction |
| `compaction-basic` `selectCompactableRange` | anchors at the first non-system node; node 0 is never inside a compaction range |
| `dsh-token-meter` | the system node is priced as a surface node under the `systemTokens` breakdown |
| Web request-prompt card, trajectory request node, request inspection | the `system/message` node; a replaced node 0 is shown as a prompt change and an appended in-history node as a prompt update, each in a collapsed inspectable card, never a chat bubble |
| Snapshot normalizer `{{system}}` placeholder, plan-mode tests | the system node's text |
| TypeScript and Python SDK expected outputs | include the `system/message` event |
| Human transcript projections | skip `system/message`; it is model history, not conversation |

`RuntimeContextProjection` and `SystemPromptProjection` both hand the loop an uncommitted message that `turn()` commits. They differ in how they observe the surface and in their operation set: runtime context follows `session/event` for its owned user-role snapshots and appends only, while the system prompt scans the current surface for system nodes on each projection because its decision depends on how many survive, and it appends or replaces per the route.

### V2-to-V3 structural conversion

The [V2-to-V3 specification](../../../../packages/session/session-format-v2-to-v3/README.md#system-head) owns system-head conversion and message identities; its [reference rules](../../../../packages/session/session-format-v2-to-v3/README.md#sequence-references) and [source refusal](../../../../packages/session/session-format-v2-to-v3/README.md#source-audit) define preservation and unsupported inputs. The migrated layout is semantically equivalent to native requests, not byte-identical to a native recording. A valid V2 source can lack an order-preserving conversion under the current step invariant; refusing it is preferable to moving history or relaxing ownership. Historical acceptance coordinates must not become acknowledgements of the transformed log.

The [released-format policy](2026-08-31-released-session-format-migrations.md) preserves each released conversion’s semantics; an existing target-format generation does not rerun its incoming edge. Projection-cache versions are independent of Session format versions.

The [canonical-envelope specification](../../../../packages/session/session-format-v2-to-v3/README.md#canonical-envelopes) defines composition with the structural conversion; the [canonical-envelope decision](2026-09-06-v3-canonical-session-envelopes.md) owns the strict-acceptance rationale.

## Alternatives considered

**Keep `header.system` and add `system/message` only for updates.** Two homes for one fact: every consumer above would read the header for message 0 and the surface for later messages, and the loop would need a special case that ignores `system` in `headerEquals` while a surface system node exists. Rejected because the point of the change is one representation.

**A dedicated log-only `system-prompt/change` event that rewrites the header.** Preserves the header as the home of the prompt and records changes as their own event kind, but still cannot express a system message inside history, so the in-history proposal would need a second mechanism anyway. Rejected.

**Synthesize the system message inside the adapter from consecutive headers.** The adapter is stateless per request and never sees the log; a wire history that depends on adapter state is not reconstructable from the surface fold. Rejected.

**Express the prompt as a `user/message` snapshot like runtime context.** Reuses an existing event type but sends the wrong role, so a model that treats a system message as authoritative would not. Rejected.

## Consequences

- One representation: every reader of "what did the model see" folds the surface; no consumer joins the header to the message list. `EpochHeader` has no `system` field, so a reader that expects one fails at compile time.
- A prompt change and a tool or config change are distinguishable in the log: the former is a `system/message` replacement of node 0 followed by a `series` header, the latter a `request/header` with reason `change`.
- Compaction carries an invariant: node 0 is never compacted. The `dsh-session` surface manager enforces it in the replace operation itself, so a compaction provider other than `compaction-basic` cannot shadow the prompt by anchoring at `surfaceNodes[0]`. Later system nodes are unprotected by design.
- `replaceGeneration` advances for a prompt replacement as well as for compaction; a reader that needs to distinguish them inspects the replacement event's type.
- A mid-history system node has a surface representation, which is what the [in-history replacement decision](../feature/2026-09-02-in-history-system-prompt-replacement.md) builds on.
- An initially empty prompt occupies the protected head without contributing a wire message; in replacement mode, a later non-empty prompt replaces it and remains the leading system message.
- Recorded snapshot fixtures carry the `system/message` event instead of a header `system` field. The snapshot normalizer tokenizes that event's text to `{{system}}`, the prompt sidecar is harvested from the `system/message` sequence (one section per prompt version, declared as `header.promptChanges`), and `request/header` pins compare config and tools only.

## Testing

- `packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts` pins zero post-call surface delta with provider usage through initial, growing, shrinking, and empty prompts, same-step retry replacement, request middleware, and fresh replay.
- `packages/core/session/tests/surface.spec.ts` (`system/message surface node` block) pins the leading system-role projection, the empty-content `null` projection, `assertSystemHeadRewrite`'s acceptance and rejection paths, the unprotected later system nodes, and the rejection of a seeded `system/message` with a non-system role or non-plugin source.
- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` pins the append on first render (including empty), the later non-empty prompt at the derived head in replacement mode, the no-op on an unchanged prompt, the replacement of the latest surviving node on change, the tail append after a replacement shadowed a non-head system node, and the in-history append and re-baseline rules.
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` (`a system-prompt change replaces surface node 0 and starts a new series under the same header`) pins the `series` header that follows a prompt replacement.
- `packages/core/agent-loop/tests/invariant.spec.ts` pins the companion's rejection of a loop request carrying a `system` field and its `messages` equality check against the boundary derivation.
- `packages/llm/llm-deepseek/tests/serialize.spec.ts` (`serializes a leading system message byte-for-byte like the same prompt passed as options.system`) pins wire identity. `packages/llm/llm-pi-ai/tests/context.spec.ts` compares both system sources on text and image paths. `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` pins the derived prefix, routed tools, absent separate `system` option, and protected non-empty or empty head through the region transaction and default summarizer.
- The recorded snapshots under `snapshots/` pin the model-visible wire request of every shipped profile; a recorded session that renders a prompt carries the `system/message` event at surface node 0 in its `session.jsonl`, and a session with a mid-session prompt change carries the replacement of node 0 or, on an in-history route, the appended node.
