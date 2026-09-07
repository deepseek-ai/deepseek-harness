# Agent Note: The system prompt is surface node 0

Status: proposed

English | [中文](2026-09-02-system-prompt-as-surface-node.zh.md)

## Problem

The system prompt has a different durable representation from every other message the model reads. Conversation messages are surface events (`user/message`, `assistant/message`, `tool/result`) folded in seq order by `Session.deriveMessages()`; the system prompt is the `system` field of the log-only `request/header` snapshot, and each DeepSeek serializer prepends it as wire message 0 (`serializeRequest`, `serializeRequestWithImages`). The [reconstructable-requests Agent Note](../../implemented/architecture/2026-07-05-reconstructable-requests.md) made both halves durable, but it left one model-visible fact with two homes: the surface owns the messages, the header owns the message in front of them.

That split forces every reader of "what did the model see" to join two sources. The compaction summarizer (`buildSummarizationInput`) copies `header.system` in front of the region's derived messages; `dsh-token-meter` estimates the system prompt from the header while pricing every other message from the surface; the Web request-prompt card, the trajectory view, and the snapshot normalizer's `{{system}}` placeholder each read the header on their own. The loop's change detection is also split: `headerEquals` compares `system` byte-for-byte beside `config` and `tools`, so a prompt change and a tool change are indistinguishable in the log (`request/header` reason `change`) even though they are different operations on the conversation.

The split also blocks the next step. A model that accepts a mid-conversation `system` message as a prompt replacement needs the harness to append a system-role message to history; with the prompt living in the header there is no surface representation to append, and the header would have to be frozen by special case. The [in-history replacement proposal](../feature/2026-09-02-in-history-system-prompt-replacement.md) depends on this note.

## Proposal

Move the system prompt onto the surface. It becomes an ordinary surface event, `system/message`, and every prompt lifecycle operation is one of the two existing `SurfaceOp` variants applied to that event type. The wire request does not change: the surface fold yields the same message list the serializers already build today, with the system message first.

### The event

`system/message` joins `SurfaceEventType` beside `user/message`, `assistant/message`, and `tool/result`. Its payload mirrors `tool/result`: `{ turn, step, message }`, where `message` is a `Message` with `role: 'system'`, exactly one text block holding the rendered prompt, and source `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`. `deriveEventMessage` projects it verbatim, so `deriveMessages()` returns the system message at its surface position and both DeepSeek serializers, which already pass a `role: 'system'` history message through unchanged, emit it as wire message 0. `EpochHeader.system` is removed; the header keeps `config`, `adapterDefaults`, and `tools`.

### The operations

| Situation | Surface operation |
|---|---|
| First request of a session with a non-empty rendered prompt | append `system/message` as surface node 0, before the first `user/message` of the step |
| Rendered prompt differs from the prompt at node 0 | replace node 0: `surfaceOp: { op: 'replace', start: <seq of node 0>, end: <same> }`, `sourceEventSeqs: [<seq of node 0>]` |
| Rendered prompt is empty on the first request | no system node; a later non-empty prompt appends node 0 when the surface has no system node yet |

Replacing node 0 is today's head rewrite expressed on the surface: the provider prefix changes from the first token, the log records the shadowed node through `sourceEventSeqs`, and `replaceGeneration` advances exactly as it does for a compaction replacement, so the loop's existing `startsSeries` detection (`requestSurfaceGeneration !== surfaceGeneration`) covers the prompt change without a `system` comparison in `headerEquals`. `request/header` keeps reasons `initial`, `resume`, `change`, and `series`; `change` now means config or tools changed.

### Ownership in the loop

`dsh-agent-loop` owns a `SystemPromptProjection` beside `RuntimeContextProjection` in `runtime-context.ts`. It restores the current system node from the log (the latest surviving `system/message` on the surface), follows `session/event` for new system nodes and for replacements whose `sourceEventSeqs` shadow the retained one, and returns the uncommitted append or replace intent when the rendered prompt differs. `turn()` commits that intent immediately before the step's `user/message` events, so the log order is the wire order. `step()` no longer passes `system` to `buildRequest`; the request is `header.config` plus `deriveMessages()` plus `header.tools`. The `dsh-agent-loop/invariant` companion keeps comparing the rebuilt request against the frozen one, now with the system message inside `messages`. `docs/architecture.md` records the new loop step order: claim, assemble, project system prompt, project runtime context, pre-step, commit system node, commit user messages, build request.

### Consumers retargeted

| Consumer | Today | After |
|---|---|---|
| DeepSeek serializers (`serializeRequest`, `serializeRequestWithImages`) | prepend `options.system` | serialize `options.messages` only; `GenerateOptions.system` remains for direct one-shot callers such as the summarizer and title providers |
| `compaction-basic` `buildSummarizationInput` | `header.system` + region messages | node 0's derived message + region messages, still a genuine prefix of the routed request |
| `compaction-basic` `selectCompactableRange` | head-anchored at `surfaceNodes[0]` | anchored at the first non-system node; node 0 is never inside a compaction range |
| `dsh-token-meter` system estimate | `header.system` length | the system node is priced like every other surface node; the context breakdown labels it by its source plugin |
| Web request-prompt card, trajectory request-header node, request inspection | read `header.system` | read the `system/message` node; the card keeps its collapsed inspectable presentation and is never a chat bubble |
| Snapshot normalizer `{{system}}` placeholder, plan-mode tests asserting `header.system` | header | the system node's text |
| TypeScript and Python SDK expected outputs | no system event | include the `system/message` event |
| Human transcript projections (`isAppendSurfaceEvent` readers) | no system events | skip `system/message`; it is model history, not conversation |

`RuntimeContextProjection` and `SystemPromptProjection` are symmetric: both watch owned surface nodes and their shadowing through `sourceEventSeqs`, and both hand the loop an uncommitted message that `turn()` commits. The difference is the role and the operation set — runtime context appends user-role snapshots only, the system prompt appends once and then replaces.

## Alternatives considered

**Keep `header.system` and add `system/message` only for updates.** Two homes for one fact: every consumer above would read the header for message 0 and the surface for later messages, and the loop would need a special case that ignores `system` in `headerEquals` while a surface system node exists. Rejected because the point of the change is one representation.

**A dedicated log-only `system-prompt/change` event that rewrites the header.** Preserves the header as the home of the prompt and records changes as their own event kind, but still cannot express a system message inside history, so the in-history proposal would need a second mechanism anyway. Rejected.

**Synthesize the system message inside the adapter from consecutive headers.** The adapter is stateless per request and never sees the log; a wire history that depends on adapter state is not reconstructable from the surface fold. Rejected.

**Express the prompt as a `user/message` snapshot like runtime context.** Reuses an existing event type but sends the wrong role, so a model that treats a system message as authoritative would not. Rejected.

## Acceptance criteria

- `SurfaceEventType` contains `system/message`; `deriveEventMessage` projects it; `Session.append('system/message', …)` requires a `SurfaceIntent` like the other surface events.
- `EpochHeader` has no `system` field; `headerEquals` compares `config`, `adapterDefaults`, and `tools` only.
- A first request with a non-empty rendered prompt appends `system/message` as surface node 0 before the step's first `user/message`; a changed prompt replaces node 0 with `sourceEventSeqs` naming the shadowed node; an unchanged prompt appends nothing.
- The DeepSeek wire request for every loop step is byte-identical to today's for the same session history: system first, then the folded conversation.
- Compaction never selects node 0; the summarizer's replayed prefix starts with node 0's derived message.
- `dsh-token-meter`, the Web request-prompt card, trajectory and inspection views, the snapshot normalizer, plan-mode tests, and both SDK expected outputs read the system node; the `dsh-agent-loop/invariant` companion rebuilds requests with the system message inside `messages`.
- Keyless recorded snapshots that exercise a mid-session prompt change (plan mode entering and leaving) show a replaced node 0 instead of a `request/header` `change`.
- `docs/architecture.md`, the `dsh-agent-loop`, `dsh-session`, `dsh-system-prompt`, `dsh-compaction-basic`, and `dsh-token-meter` READMEs, and the reconstructable-requests Agent Note describe the surface node as the home of the system prompt.

## Risks

- Every reader of `header.system` moves in one change; a missed reader fails at compile time because the field is gone, which is the intended failure mode.
- Compaction region selection gains an invariant (node 0 is never compacted). A compaction provider other than `compaction-basic` that anchors at `surfaceNodes[0]` would shadow the prompt; the `dsh-session` surface manager rejects a replacement whose range covers surface node 0 while node 0 is a `system/message` unless the replacing event is itself a `system/message` covering exactly that node, so the invariant is enforced where the operation happens, not only in the shipped provider. System nodes at later positions carry no such protection: a compaction range may shadow them.
- Replacing node 0 advances `replaceGeneration`, which today means "compaction happened" to some readers; those readers switch to inspecting the replacement event's type.
- Recorded snapshot fixtures whose logs contain `header.system` are re-recorded; the fixtures, not the normalizer, change.
