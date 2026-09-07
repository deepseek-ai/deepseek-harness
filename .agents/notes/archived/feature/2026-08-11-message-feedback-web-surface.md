# Agent Note: Web surface for message feedback

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-message-feedback-web-surface.zh.md)

## Problem

[PR #2217](https://github.com/deepseek-harness/deepseek-harness/pull/2217) landed the durable message-feedback sidecar and its three Host Remote methods, but it was explicitly backend-only: no client package consumed `messageFeedback.list`, `put`, or `delete`, so the Web GUI had no way to record a rating. Its Agent Note deferred "client Remote aggregate mounting and UI" to a separate owner. Issue #1326 asks for the Web surface and was closed by that backend merge without the user-visible half existing.

An earlier full-stack attempt, [PR #1010](https://github.com/deepseek-harness/deepseek-harness/pull/1010), carried a UI layer but was built against its own backend with a different shape: one Session-wide `revision` for compare-and-swap and RPC named `feedback.upsert`. #2217 shipped per-item `ifVersion` and `messageFeedback.put` instead, so #1010's controller logic no longer matched the contract, and its branch had also drifted structurally (it edited `packages/cordis/`, renamed to `packages/extensions/`, and added a top-level `packages/session-feedback/` that conflicts with the consolidated `packages/feedback/`). It was closed as superseded rather than rebased.

The blocking gap for any UI was that the browser could not name a feedback target. The Host accepts only an append-origin `assistant/message` addressed by `MessageId`, but `AssistantMessageNode` — the client's finalized-assistant node — carried `seq`, `turn`, and `step` and no message identity. Only `SteeringMessageNode` had a `messageId`.

## Decision

Three seams, each owned where its authority already lives.

**Message identity in the client node.** `AssistantMessageNode` gains an optional `messageId`, copied from `event.data.message.id` where the node is materialized from a finalized `assistant/message`. It stays absent on interruption-frozen partials, which were never finalized and address no durable message, and on the synthetic sentinel the trajectory layout builds for an unfinalized partial. The field is optional precisely so those two cases remain unrepresentable as feedback targets rather than being papered over with a placeholder. `ui-conversation` and `ui-trajectory` each materialize their own copy of this node, so both finalized branches were updated; the interrupted branches were deliberately left alone. This mirrors the Host's own target rule, which filters on `isAppendSurfaceEvent`, so client and Host agree on what is addressable without sharing code.

**A declared slot rather than a direct dependency.** `ui-conversation` declares `conversation.chat.assistant-actions` (list kind, session scope, owner `{messageId}`) and authorizes it as a second child of the `turn-tail` node renderer, next to the existing `conversation.chat.turnTail` chain. `TurnTailNodeView` renders it and threads the result into `MessageIconActions` through a new `extraActions` prop, placed between copy and branch. The render site skips the slot entirely when `messageId` is absent, so an interrupted turn shows no controls. The feedback package therefore contributes an entry and never imports the conversation implementation; the strip renders nothing at zero cost when the plugin is composed out of `cordis.yml`.

`extraActions` is a `ReactNode` prop rather than a second render-slot hole because `MessageIconActions` is shared chrome for user and assistant messages: the assistant caller resolves the slot and passes the result down, so the user path stays unaware of a slot it must never render.

**Per-item CAS in a per-session controller.** `@deepseek-ai/dsh-client-ui-message-feedback` holds one `MessageFeedbackController` per Session, keyed by `MessageId` in a map. A single `list` seeds every control in that Session's transcript. Each mutation sends the version that controller last observed as `ifVersion` — `null` when it knows of no item, which is exactly the Host's "must not exist" precondition.

The conflict path is where this diverges most from #1010. `MessageFeedbackVersionConflict` carries the authoritative `current` item (or `null`), so a lost race reconciles from the reply itself; #1010 answered every conflict with a blind full refresh. A conflict reporting `current: null` deletes the local entry, which is how a rating removed in another tab disappears here. Mutations serialize on a per-Session tail so a queued operation always compares against the committed version rather than the version read when the click landed.

The list read is deferred to the first hover or focus, not fired on mount, because the controls mount once per settled message in the visible history; a transcript-wide read on mount would fan out one request per message strip. `connection/reset` refreshes only Sessions whose status is no longer `cold`, so a reconnect does not warm Sessions nobody has looked at.

Toggle semantics keep the two verbs honest: re-clicking the recorded rating calls `delete`, switching sides calls `put` and carries any existing note forward, and clearing a message with no known item returns success without a call because it is already in the requested state.

**Remote mounting.** `@deepseek-ai/dsh-api-remotes` now mounts `messageFeedbackRemote` alongside `goalsRemote` and composes both disposers in reverse order. The generated `./remote` artifact already existed in #2217's package exports, so no codegen change was needed; the client calls `ctx.remote.messageFeedback` and never touches the transport. Business results cross this boundary as the ordinary tagged union — the gateway throws only on transport failure — so the controller pattern-matches `ok` and translates a throw into the same settled result shape the controls already render.

## Alternatives considered

**Reuse `conversation.chat.turnTail` instead of a new slot.** Rejected: `turnTail` is a chain keyed on the Turn and carries `TurnTailOwnerProps {turn, seq, openFile}`, which addresses a Turn boundary rather than a message identity. Feedback needs `MessageId`, and a chain is selector-routed one-at-a-time where the action strip is genuinely a list of independent contributors.

**Put `messageId` on the chat node's `id` field.** Rejected: that id is `"${turn}:${step}"` and is load-bearing for keyed dispatch and stable React keys. Overloading it would couple node identity to model output identity, and a message id is not unique per node anyway once replacement-origin events exist.

**Keep #1010's session-wide revision.** Not available: the merged Host contract is per-item `ifVersion`. Even as a client-side simplification it would be worse — one Session revision makes unrelated per-message edits conflict, which is the precise problem #2217's Agent Note records as the reason for per-item versions.

**Rebase #1010.** Rejected after inspection: 102 files, `mergeable: false`, a duplicate backend and RPC layer that #2217 supersedes under different names, and two directory renames since. Only its ~1,400-line UI layer had residual value, and that layer called `feedback.upsert` with a revision it no longer has. Rewriting the UI against the merged contract was less work than reconciling the branch, and the closing comment on #1010 records that reasoning.

## Consequences

The Web GUI records per-message ratings and notes. #1326's user-visible half now exists; the issue was reopened because the backend merge had closed it while no entry point existed.

`AssistantMessageNode.messageId` is optional, so every existing reader compiles unchanged, but any future consumer must handle absence rather than assume a finalized message. The two parallel materializers remain a duplication hazard: a third view that builds this node must remember to copy the id, and nothing enforces it. Only the chat view renders controls, even though trajectory and waterfall nodes now carry the same id.

Feedback stays invisible to the model — the sidecar reaches neither the Session log, model context, nor telemetry — so the package's Model Experience is an audited `none` entry rather than a structured block.

The sidecar publishes no live frames, so a second tab's rating surfaces on reconnect or on the next conflict reply, not immediately. The note editor does not pre-check `maxNoteBytes` (8192 in the Web bundle), so an oversized note fails on save with `note-too-large` rather than while typing.

Twenty-four existing Web UI snapshots gained the two rating buttons across 27 assistant messages, confirming the strip reaches every settled assistant message in the shipped composition rather than only the fixture under test.

A dedicated Web E2E covers rate, note, reload restore, and retract against the shipped bundle. It has to hover the unrated control after a reload before asserting the restored state, because the deferred list read is what makes the sidecar value appear — the test documents that ordering rather than working around it. Sabotaging the controller's list restore makes the spec fail, so the durability assertion has teeth.
