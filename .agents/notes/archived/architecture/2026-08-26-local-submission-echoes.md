# Agent Note: Local submission echoes over the prompt rpcId

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-local-submission-echoes.zh.md)

## Problem

A multi-image prompt spent seconds in client serialization plus host admission before its durable `user/message` existed, and the conversation showed nothing until then: the composer froze read-only, the message appeared only after the full pipeline, and the user could not tell whether the submission had started (#3003). The durable event cannot move earlier — Model-visible ⟺ logged requires the `user/message` to land only after every attachment persists — so the visible submission had to decouple from the durable one.

## Decision

**The Session object owns a client-local submission echo, correlated by the prompt's existing `requestId`/`rpcId`.** `session.beginSubmission` synchronously inserts `{requestId, text, images: previews}` into `SessionSnapshot.pendingSubmissions` and flips `promptAttempted`, before the caller serializes anything; the same `requestId` rides the prompt RPC. No new correlation id, no wire-type change, and no session-log change: the host already stamps the prompt's `requestId` into the durable user source as `rpcId`, and the queue projection now carries it as `SessionQueuedItem.rpcId` for prompts that land in the inbox instead of the log (running-turn submissions).

**Retirement is observation-driven with a one-frame delay; display dedupe is render-time and declarative.** The Session marks an echo observed when a durable `user/message` or queue occurrence with its rpcId arrives (append, window install, or control frame) and removes it one animation frame later — after the conversation assembly's frame, which was scheduled first. ChatView independently hides any echo whose rpcId appears among rendered user/steering nodes or queue rows, so within every render exactly one of echo/durable is visible regardless of store update order. An identified prompt failure, `abandon()`, or disposal retires the echo immediately as failed; the first settlement wins.

**Queue actions require the observed Host identity.** Queued echoes display a sending status and disabled edit, remove, and steer buttons in the same positions as admitted rows. The collapsed dock retains that status in its header. Prompt acknowledgement alone carries no queue-item identity, so only the correlated Host row enables its applicable actions. This keeps slow admission visible without treating a local request id as a mutable Host queue item.

**The composer commits optimistically.** Enter clears the draft, occurrence table, and undo history in one machine transaction and keeps phase `plain`; the send runs as a detached attempt (concurrent sends allowed; the single frozen in-flight slot remains command-only). Failed detached sends are restored together in submission order while the composer is empty or still contains the preceding automatic restoration; a user edit ends that restoration sequence. Draft images remain owned by the detached attempt through echo retirement, so Session scope disposal can release them after they have left the rail. An observed echo gives each preview URL to `HistoricalImageCache.seed` under the admitted reference. The cache exposes that preview synchronously, fetches the durable attachment, replaces the preview with the canonical URL, and revokes both URLs with their respective lifetimes. Direct subagent continuations do not register echoes because their transport assigns a different RPC identity and image input is unsupported.

Client image encoding switched from the synchronous chunked-`btoa` loop to `FileReader.readAsDataURL` (native encode). The browser→host transport still ships one base64 JSON envelope; that remaining #2885 transport work is out of scope here.

## Consequences

The submit click paints its message and docks the composer on the same frame, for ordinary text and image prompts, while admission timing is unchanged. The composer never freezes for default sends, so drafts can be typed and sent during a flight; the machine's `submitting` phase now occurs only for command submissions. A prompt whose RPC response is lost but whose admission succeeded converges through observation instead of double-posting. An admitted image keeps its local preview until the durable bytes resolve, then displays the host-authoritative rendition without a loading placeholder.

## Verification

Session client specs pin synchronous insertion, requestId threading, event/queue/window observation, one retirement when queue and durable observations coincide, frame-delayed removal, abandon, and disposal. Machine and shell specs pin optimistic commit, concurrent detached settlement, ordered multi-failure restoration, image-only cancellation, and image ownership through scope disposal. ChatView specs pin flow-tail rendering and node- and queue-keyed dedupe with the echo still in the snapshot. Host control specs pin the queue rpcId projection; cache and attachment specs pin synchronous seeded display, canonical replacement, and URL revocation. The connection fixture echoes `requestId`, and the `fresh-round-trip` recorded-session snapshot captures the local echo before durable admission.

## Alternatives considered

**A new `clientSubmissionId` threaded through the wire and the user source.** Rejected: `requestId` already exists end-to-end (`user-rpc` source member), so a second id would duplicate the correlation and touch wire validation for nothing.

**Retire the echo synchronously on event ingestion.** Rejected: the chat assembly publishes on an animation frame, so synchronous removal blanks the message for a frame. The steering queue mirror historically accepted that race; the echo path removes it via render-time dedupe plus the delayed retirement.

**Render echoes through the conversation assembler as synthetic nodes.** Rejected: the assembler is driven by durable session events only, and a client-only node kind would widen the closed `ConversationNode` union into every target's `assertNever`; the `PartialAssistant`-style side-channel state matches the existing precedent.

**Keep the composer frozen and only add the echo.** Rejected: the issue's acceptance requires consecutive and concurrent submissions, and a frozen composer reintroduces the perceived hang the echo exists to remove.
