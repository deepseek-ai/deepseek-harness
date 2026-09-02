# Message Feedback

English | [中文](feedback.zh.md)

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback) owns editable feedback for individual assistant messages. It is deliberately separate from the immutable Session-level `feedback/record` event: message feedback is a local storage-domain sidecar, not Session-log content or a projection, and it performs no telemetry handoff.

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
  /** Equality-only token replaced by every material create or update. */
  readonly version: MessageFeedbackVersion
  /** Host-assigned creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Host-assigned time of the most recent material update. */
  readonly updatedAt: number
}
```

```ts type-equiv
/** Read all message feedback belonging to one persisted Session lifecycle. */
interface MessageFeedbackListRequest {
  /** Persisted Session whose sidecar should be read. */
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
  /** Observed item version, or `null` to require that no item exists. */
  readonly ifVersion: MessageFeedbackVersion | null
}
```

```ts type-equiv
/** Delete feedback for one message after observing its current version. */
interface MessageFeedbackDeleteRequest {
  /** Persisted Session that owns the sidecar. */
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

## Data and concurrency

One Session sidecar row contains its header identity `{createdAt, cwd}` and feedback items keyed by `MessageId`. Each item carries a positive or negative rating, an optional note, Host-assigned `createdAt`/`updatedAt` timestamps, and its own opaque version. Versions are compared only for equality and only against the addressed message; callers do not order or synthesize them.

`put` uses strict optimistic concurrency: every request for an existing item must match its current `ifVersion`, including a no-op. A conflict returns the authoritative current item (or `null`), so a caller can reconcile a lost response or a concurrent edit without another read. Deleting an already absent item succeeds. A per-Session queue encloses inspection, read, conflict evaluation, and whole-row write, so these guarantees cover concurrent calls in one Host process.

## Target and lifecycle authority

A live owner's in-memory log supplies the target Session observation directly; a cold target is read through a `SessionPersistence.open(id, 'read')` handle without publishing or resuming an Agent and without writing recovery. A `stat(id)` preflight classifies definite absence; a read failure for a Session `stat` confirmed propagates as infrastructure failure. `put` accepts only a non-empty, append-origin `assistant/message` with the requested `MessageId`; replacement-origin, usage-only empty, and non-assistant records are not feedback targets.

The stored `{createdAt, cwd}` identity must match the inspected header. A mismatch is treated as absence: `list` returns no items, while `put` may replace the stale row with one bound to the current header identity. Forks use a new Session identity and receive no sidecar copy even when their seed contains the same messages.

## Persistence and Remote contract

The service stores whole Session rows in the `message_feedback` storage domain through `ctx.storageDomain`. Before `put` commits a row that references a target message, a matching live target passes through the canonical `ctx.sessions.flush` checkpoint; both live and cold paths are then physically read from sequence zero through a fresh read handle, which observes at least the flushed prefix by the seam's freshness guarantee. The resulting observation is revalidated before the sidecar write, so the durable target log always precedes its sidecar commit. `maxNoteBytes` is required and bounds note text by UTF-8 bytes; the Web Host composition sets `8192`. The package publishes the Host `messageFeedback.list`, `messageFeedback.put`, and `messageFeedback.delete` unary Remote contract through `TypertRemoteService` and `@Remote`; the generated Cordis API below is the method-level authority.

Plugin disposal closes mutation admission, drains accepted per-Session queue work, and then closes the storage domain.

## Web surface

[`@deepseek-ai/dsh-client-ui-message-feedback`](../../packages/client/ui-message-feedback) is the browser consumer. `@deepseek-ai/dsh-api-remotes` mounts the generated `messageFeedback` contribution, so the plugin calls `ctx.remote.messageFeedback` and never touches the transport.

The controls are the `feedback` entry (order 10) of the `conversation.chat.assistant-actions` list slot, which `ui-conversation` declares and renders inside the finalized assistant message's IconActions row. `AssistantMessageNode` carries the optional `messageId` from the `assistant/message` event. The field is absent on interruption-frozen partials, and the render site skips the slot when it is absent. The strip renders once per turn, on the closing assistant message: the Host accepts every append-origin step message as a target, but earlier steps of a multi-step turn render tool rows rather than a rateable body, so the UI exposes a narrower set than the Host contract allows.

One `MessageFeedbackController` per Session backs every message control in that Session: a single `list` read seeds the whole transcript, deferred to first hover or focus rather than fired on mount. Each mutation sends the version that controller last observed as `ifVersion`; a `version-conflict` reply carries the authoritative item, so the controller reconciles from the reply instead of refetching. Mutations serialize per Session so a queued operation compares against the committed version. A `connection/reset` refreshes only Sessions already read.

## Boundaries and limitations

- The mutation queue is process-local. Storage-domain has no cross-process conditional write, so multiple Host writers to one storage root have no compare-and-swap or lost-update guarantee.
- Session persistence has no durable deletion API. The service does not treat `session/disposed` or `api-session/removed` as deletion and therefore performs no fake cascade; orphan sidecar rows may remain after out-of-band log removal.
- A request in the narrow interval after live detach but before the persistence catalog materializes the header can receive `session-not-found`; callers retry after retirement materialization.
- Cold requests scan the complete Session snapshot catalog because persistence has no lookup-by-id metadata operation. One Session row also has no item-count or aggregate-byte cap; `maxNoteBytes` bounds only each note until a concrete consumer owns a row policy.
- Header identity detects a reused id only when `{createdAt, cwd}` differs; a cloned log retaining the same header identity is indistinguishable by this contract.
- The Host contract records no authenticated actor or audit identity and therefore assumes a trusted caller boundary.
- The Web controls appear in the chat view only. The trajectory and waterfall views render no feedback entry even though their assistant nodes carry the same `messageId`.
- The sidecar publishes no live frames, so a second tab's rating becomes visible on reconnect or on the next conflict reply rather than immediately.
- The note editor does not pre-check `maxNoteBytes`; an oversized note fails on save with `note-too-large` rather than while typing.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Storage-domain sidecar service. It inspects persisted Session history and never creates or resumes an Agent or Session.

```ts cordis-catalog
/**
 * Read feedback belonging to the current persisted Session lifecycle.
 * A stale row from a reused Session id is invisible.
 * @param request - Session identity to inspect and list.
 * @returns current immutable items or `session-not-found`.
 */
@Remote('list') async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback for one derived append-origin assistant
 * message. Every request must match the addressed item's current version;
 * a matching no-op returns the stored item without changing its revision.
 * @param request - target, desired value, and observed item version.
 * @returns the committed item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one feedback item. Absence is successful regardless of the
 * supplied version; an existing item requires an exact version match.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition, or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
