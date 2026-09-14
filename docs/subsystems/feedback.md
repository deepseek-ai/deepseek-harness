# Message Feedback

English | [中文](feedback.zh.md)

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback) owns editable feedback for individual assistant messages. The canonical Session log stores `feedback/message-put` and `feedback/message-delete`; the immutable Session-level remark remains `feedback/record`, owned by [`@deepseek-ai/dsh-command-feedback`](../../packages/feedback/command-feedback) together with the `FeedbackCategory` taxonomy both kinds of feedback file under. All three are log-only events that never enter model context.

Source: [`packages/feedback/message-feedback/src/types.ts`](../../packages/feedback/message-feedback/src/types.ts)

## Public types

```ts type-equiv
/** Opaque compare-and-set token for one exact feedback item revision. */
type MessageFeedbackVersion = Branded<'MessageFeedbackVersion'>
```

```ts type-equiv
/** The human's overall judgment of one assistant message. */
type MessageFeedbackRating = 'positive' | 'negative'
```

```ts type-equiv
/** One current feedback value and its opaque mutation token. */
interface MessageFeedbackItem {
  /** Stable identity of the assistant message inside the owning Session. */
  readonly messageId: MessageId
  /** Overall positive or negative judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional explanation, preserved verbatim after validation. */
  readonly note?: string
  /** Category the human filed the judgment under. */
  readonly category?: FeedbackCategory
  /** Equality-only token replaced by every material create or update. */
  readonly version: MessageFeedbackVersion
  /** Host-assigned creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Host-assigned time of the most recent material update. */
  readonly updatedAt: number
}
```

```ts type-equiv
/** A material creation or edit, retaining its complete current value. */
interface MessageFeedbackPut {
  /** Owning Session; inherited feedback in a fork belongs to its parent. */
  readonly sessionId: SessionId
  /** Value after this mutation, including the original creation time. */
  readonly item: MessageFeedbackItem
}
```

```ts type-equiv
/** A material deletion of one current feedback item. */
interface MessageFeedbackDelete {
  /** Session that owns the deleted feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback was removed. */
  readonly messageId: MessageId
}
```

```ts type-equiv
/** Read all message feedback belonging to one persisted Session lifecycle. */
interface MessageFeedbackListRequest {
  /** Session whose feedback events should be read. */
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** Current feedback values for one Session, in first-creation order. */
interface MessageFeedbackListValue {
  /** Fresh immutable item snapshots. */
  readonly items: readonly MessageFeedbackItem[]
}
```

```ts type-equiv
/** Create or replace feedback for one assistant message. */
interface MessageFeedbackPutRequest {
  /** Persisted Session that owns the target message. */
  readonly sessionId: SessionId
  /** Target assistant-message identity. */
  readonly messageId: MessageId
  /** Desired overall judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional non-blank explanation. */
  readonly note?: string
  /** Optional category; absent keeps the item uncategorized. */
  readonly category?: FeedbackCategory
  /** Observed item version, or `null` to require that no item exists. */
  readonly ifVersion: MessageFeedbackVersion | null
}
```

```ts type-equiv
/** Delete feedback for one message after observing its current version. */
interface MessageFeedbackDeleteRequest {
  /** Session that owns the feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback should be absent after this operation. */
  readonly messageId: MessageId
  /** Observed item version; ignored when the item is already absent. */
  readonly ifVersion: MessageFeedbackVersion
}
```

```ts type-equiv
/** Idempotent deletion acknowledgement. */
interface MessageFeedbackDeleteValue {
  /** Stable postcondition shared by the first deletion and every retry. */
  readonly absent: true
}
```

```ts type-equiv
/** No persisted Session header exists for the requested id. */
interface MessageFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** The id does not name a derived, append-origin assistant message. */
interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found'
  readonly sessionId: SessionId
  readonly messageId: MessageId
}
```

```ts type-equiv
/** A material mutation did not match the addressed item's current version. */
interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict'
  /** Authoritative current item, or `null` when it does not exist. */
  readonly current: MessageFeedbackItem | null
}
```

```ts type-equiv
/** A supplied note contains no non-whitespace character. */
interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank'
}
```

```ts type-equiv
/** A supplied note exceeds the configured UTF-8 byte limit. */
interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large'
  readonly maxBytes: number
  readonly actualBytes: number
}
```

```ts type-equiv
/** Failures shared by the public message-feedback operations. */
type MessageFeedbackFailure =
  | MessageFeedbackSessionNotFound
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge
```

```ts type-equiv
/** Successful public operation result. */
interface MessageFeedbackSuccess<T> {
  readonly ok: true
  readonly value: T
}
```

```ts type-equiv
/** Rejected public operation result with a stable business failure. */
interface MessageFeedbackRejected<E extends MessageFeedbackFailure> {
  readonly ok: false
  readonly error: E
}
```

```ts type-equiv
/** Result returned by the message-feedback `list` operation. */
type MessageFeedbackListResult =
  | MessageFeedbackSuccess<MessageFeedbackListValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>
```

```ts type-equiv
/** Result returned by the message-feedback `put` operation. */
type MessageFeedbackPutResult =
  | MessageFeedbackSuccess<MessageFeedbackItem>
  | MessageFeedbackRejected<
    | MessageFeedbackSessionNotFound
    | MessageFeedbackTargetNotFound
    | MessageFeedbackVersionConflict
    | MessageFeedbackNoteBlank
    | MessageFeedbackNoteTooLarge
  >
```

```ts type-equiv
/** Result returned by the message-feedback `delete` operation. */
type MessageFeedbackDeleteResult =
  | MessageFeedbackSuccess<MessageFeedbackDeleteValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>
```

## Session feedback types

Source: [`packages/feedback/command-feedback/src/types.ts`](../../packages/feedback/command-feedback/src/types.ts)

```ts type-equiv
/** One of the fixed feedback categories; the ids are durable log vocabulary. */
type FeedbackCategory =
  | 'task-result'
  | 'instruction-following'
  | 'product-interaction'
  | 'service-stability'
  | 'resource-cost'
  | 'security-privacy-permission'
  | 'other'
```

```ts type-equiv
/**
 * One recorded human remark about a Session. Both members are optional: a
 * submission with neither still records that the human asked for the
 * Session to be reviewed, which is what authorizes log delivery.
 */
interface FeedbackRecord {
  /** Free-text remark with surrounding whitespace removed; never empty when present. */
  readonly text?: string
  /** Category the human filed the remark under. */
  readonly category?: FeedbackCategory
}
```

```ts type-equiv
/** Record one Session-level remark through the Host Remote. */
interface SessionFeedbackRecordRequest {
  /** Live Session the remark describes. */
  readonly sessionId: SessionId
  /** Free-text remark; blank text is recorded as absent. */
  readonly text?: string
  /** Category the human filed the remark under. */
  readonly category?: FeedbackCategory
}
```

```ts type-equiv
/** Stable postcondition of a recorded remark. */
interface SessionFeedbackRecordValue {
  /** The remark is appended to the Session log; flushing follows the Session's own schedule. */
  readonly recorded: true
}
```

```ts type-equiv
/** No live Session carries the requested id. */
interface SessionFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** Result returned by the `sessionFeedback.record` operation. */
type SessionFeedbackRecordResult =
  | { readonly ok: true; readonly value: SessionFeedbackRecordValue }
  | { readonly ok: false; readonly error: SessionFeedbackSessionNotFound }
```

## Data and concurrency

Current items are folded from canonical feedback events whose payload `sessionId` matches the owning Session. Each item carries a positive or negative rating, an optional note, an optional category, Host-assigned `createdAt`/`updatedAt` timestamps, and its own opaque version. Versions are compared only for equality and only against the addressed message; callers do not order or synthesize them.

`put` uses strict optimistic concurrency: every request for an existing item must match its current `ifVersion`, including a no-op (a put repeating the stored rating, note, and category). A conflict returns the authoritative current item (or `null`), so a caller can reconcile a lost response or a concurrent edit without another read. Deleting an already absent item succeeds. A per-Session queue serializes reads and mutations; cold mutations hold a persistence write handle across read, comparison, append, and flush. Matching no-ops append no event.

## Target and lifecycle authority

A live owner's in-memory log supplies the target Session observation directly; cold reads use a `SessionPersistence.open(id, 'read')` handle, while mutations use a write handle. Neither path constructs a Session or Agent. A `stat(id)` preflight classifies definite absence; a read failure for a Session `stat` confirmed propagates as infrastructure failure. `put` accepts only a non-empty, append-origin `assistant/message` with the requested `MessageId`; replacement-origin, usage-only empty, and non-assistant records are not feedback targets.

Fork seeds can contain parent feedback events, but their payload retains the parent `sessionId`, so they do not become current feedback for the child. Deleting an item appends a tombstone; earlier ratings and notes remain in the log.

## Persistence and Remote contract

Successful message-feedback mutations await canonical persistence: live operations append through the owning Session and require a participating `ctx.sessions.flush` listener; cold operations append and flush through their write handle. Persistence failures propagate rather than reporting success. `maxNoteBytes` is required and bounds note text by UTF-8 bytes; the Web Host composition sets `8192`. The package publishes the Host `messageFeedback.list`, `messageFeedback.put`, and `messageFeedback.delete` unary Remote contract through `TypertRemoteService` and `@Remote`; `command-feedback` publishes `sessionFeedback.record` the same way for Session-level remarks on live Sessions. The generated Cordis API below is the method-level authority.

Plugin disposal closes operation admission and drains accepted per-Session queue work.

When explicitly enabled, [`session-log-deepseek`](../../packages/session/session-log-deepseek/README.md) carries feedback as part of the ordinary `dsh_session_log` suffix on subsequent eligible DeepSeek requests. Recording feedback does not trigger an LLM request or a separate `dsh_feedback` upload. For non-DeepSeek routes, the [OTel backend](../../packages/session/session-telemetry-otel/README.md) can release the canonical prefix through recorded feedback. The command acknowledgement confirms recording and identifies the Session and anonymous user; it reports neither telemetry policy nor delivery.

## Web surface

[`@deepseek-ai/dsh-client-ui-message-feedback`](../../packages/client/ui-message-feedback) is the browser consumer. `@deepseek-ai/dsh-api-remotes` mounts the generated `messageFeedback` and `sessionFeedback` contributions, so the plugin calls `ctx.remote.messageFeedback` and `ctx.remote.sessionFeedback` and never touches the transport.

The controls are the `feedback` entry (order 10) of the `conversation.chat.assistant-actions` list slot, which `ui-conversation` declares and renders inside the finalized assistant message's IconActions row. `AssistantMessageNode` carries the optional `messageId` from the `assistant/message` event. The field is absent on interruption-frozen partials, and the render site skips the slot when it is absent. The strip renders once per turn, on the closing assistant message: the Host accepts every append-origin step message as a target, but earlier steps of a multi-step turn render tool rows rather than a rateable body, so the UI exposes a narrower set than the Host contract allows.

One `MessageFeedbackController` per Session backs every message control in that Session: a single `list` read seeds the whole transcript, deferred to first hover or focus rather than fired on mount. Each mutation sends the version that controller last observed as `ifVersion`; a `version-conflict` reply carries the authoritative item, so the controller reconciles from the reply instead of refetching. Mutations serialize per Session so a queued operation compares against the committed version. The injected `retract` operation rechecks the committed rating inside that queue and becomes a no-op after a concurrent change, so stale UI cannot bypass the dialog by recording a bare rating. A `connection/reset` refreshes only Sessions already read.

Either unrecorded rating opens the Session's feedback dialog, the `feedback-dialog` entry of `conversation.input.overlay`: the shared Modal card with seven category chips and a detail box. Submit puts the selected judgment carrying the chosen category and the trimmed description, or neither; success closes the dialog and shows the acknowledgement toast, while failure keeps the dialog and draft open and shows a warning toast. The same dialog opens for the Session from a bare `/feedback` — a decoration `ui-commands` routes as an `action` — and then records through `sessionFeedback.record`; `/feedback <text>` keeps the Host command path. Clicking a recorded rating retracts it without opening the dialog.

## Boundaries and limitations

- The operation queue is process-local; cold writer exclusion relies on the selected persistence provider.
- Deletion removes the current item, not earlier note text from the append-only log or an already delivered suffix.
- A request in the narrow interval after live detach but before the persistence catalog materializes the header can receive `session-not-found`; callers retry after retirement materialization.
- Cold requests read the complete log; the service has no item-count or aggregate-byte cap. `maxNoteBytes` bounds only each note.
- The Host contract records no authenticated actor or audit identity and therefore assumes a trusted caller boundary.
- The Web controls appear in the chat view only. The trajectory and waterfall views render no feedback entry even though their assistant nodes carry the same `messageId`.
- The Web controller does not consume feedback log events, so a second tab's rating becomes visible on reconnect or on the next conflict reply rather than immediately.
- The dialog does not pre-check `maxNoteBytes`; an oversized description for a message fails on submit with `note-too-large` rather than while typing. A Session remark has no size bound, as the `/feedback` command never had one.
- `sessionFeedback.record` serves live Sessions only and answers `session-not-found` otherwise; the dialog reports that failure when its Session retires while it is open.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Session-log service; cold operations never construct a Session or Agent.

```ts cordis-catalog
/**
 * Read current feedback from the canonical log.
 * @param request - Session to inspect.
 * @returns immutable items or a definite persistence miss.
 */
@Remote('list') list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback after checking its current version.
 * Matching no-ops retain the version and append no event.
 * @param request - Target, desired value, and observed item version.
 * @returns the durable item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one item after checking its version; absence succeeds without an event.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)

<a id="ctxsessionfeedback--sessionfeedbackservice"></a>

### `ctx.sessionFeedback` — `SessionFeedbackService`

Host Remote through which a product surface records a Session-level remark.

```ts cordis-catalog
/**
 * Record one remark on a live Session.
 * @param request - target Session plus the optional text and category.
 * @returns the recorded postcondition, or `session-not-found` when no live
 * Session carries the id.
 */
@Remote('record') record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult>
```

Source: [`packages/feedback/command-feedback/src/index.ts`](../../packages/feedback/command-feedback/src/index.ts)

<a id="feedback-events"></a>

### `feedback/*` events

<a id="feedbackcommitted--parallel"></a>

#### `feedback/committed` — parallel

Observe a durable cold feedback mutation without publishing a live Session. Observers run before write ownership is released and must not await another message-feedback operation for this Session. The payload is borrowed read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).

```ts cordis-catalog
/**
 * Observe a durable cold feedback mutation without publishing a live Session.
 * Observers run before write ownership is released and must not await
 * another message-feedback operation for this Session. The payload is borrowed
 * read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).
 * @param inspection - committed canonical prefix, including the feedback as its last event.
 * @mode parallel
 */
'feedback/committed'(inspection: SessionInspection): void
```

Types: [SessionInspection](persistence.md)

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
