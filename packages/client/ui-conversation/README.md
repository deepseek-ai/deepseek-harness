---
description: "Target-neutral conversation assembly and browser shell: event and view registries, per-session bindings, input state, slots, and temporary composer takeovers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation

English | [中文](README.zh.md)

## Summary

`ui-conversation` owns target-neutral Conversation assembly and the shared browser shell. It consumes Session Controller `SessionEventLikeEntry` feeds, exposes React-free registries and per-Session bindings through `ctx.uiConversation`, and contributes the `useConversation`, `useInput`, and `inputActions` standard props through `ctx.uiSession`. It also owns the per-session durable image URL cache: `ctx.uiConversation.imageUrl(sessionId, attachment)` resolves one session-authorized browser URL per attachment and revokes it with the Session binding, so every Conversation target shares one `session.attachment` read. Concrete targets such as Chat are separate packages that register their own Definitions, snapshot builders, Views, and renderers.

## Table of Contents

- [Conversation assembly](#conversation-assembly)
- [Shell and standard props](#shell-and-standard-props)
- [Temporary composer entries](#temporary-composer-entries)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="conversation-assembly"></a>
## Conversation assembly

`UiConversation.events` is the single registry for event Definitions, and `UiConversation.views` is the single registry for target snapshot builders. Both registries reject duplicate keys, preserve registration order, return idempotent disposers, and rebuild existing bindings when their contribution roster changes. `UiConversation.binding(bindingOrSessionId)` returns one identity-stable Conversation binding for the current Session Controller binding. It does not open another event source.

The adapter passes each `SessionEventLikeEntry` directly to the assembler. Its outer `type` distinguishes durable events from Client-only transient events, while its inner `event` always exposes `type`, `seq`, `time`, and `data`; Definitions receive that inner `SessionEventLike`. Replacement windows may include both entry variants, while historical prepends carry durable entries and live appends may carry either. Every Definition uses the same `match` and `update` methods for both event forms, while `start` receives only a durable event and the assembler rejects a transient start. Definitions that do not consume Assistant deltas return `null` for `assistant/live-chunk`. Replacement windows and revision gaps rebuild from the complete loaded window; contiguous append, prepend, and Assistant-settlement revisions use incremental assembly. Settlement removes only the named attempt's transient matches, applies its optional durable entry, and replays the affected Contexts and dependents without replacing unrelated target nodes. The assembler owns Context matching, Turn/Step locations, target node materialization, target activity, and stable target sources. `ConversationSnapshot` contains only target-neutral views and active-target facts; Session lifecycle state remains in `SessionSnapshot`.

A target becomes active when shell selection resolves it or when its source receives a first subscriber. The assembler replaces that target from current Contexts once and keeps it active for later incremental flushes; creating a source does not activate it and unsubscription does not deactivate it.

Target packages declaration-merge their snapshot and Location data maps, then register with `ctx.uiConversation.events.register(...)` and `ctx.uiConversation.views.register(...)`. A target reads its Session-owned source with `ctx.uiConversation.binding(binding).target(targetId)`. Registrations are Cordis effects and their returned disposers remove the contribution from the same registry.

<a id="shell-and-standard-props"></a>
## Shell and standard props

The package registers the optional-Session `conversation` shell, strict Session header/body entries, View list, composer chain and bar, input regions, Hero regions, queue dock, draft persistence, and phase calculation. `ctx.uiSession.provide()` materializes the Conversation and input sources from the same Session binding and supplies `inputActions` as a stable standard prop.

View selection is deterministic: a registered persisted selection wins, otherwise registered `chat` wins, otherwise no View renders. It never chooses the first registered View. Shell phase combines Session lifecycle with the active-target set; no target-specific snapshot is read by the shell.

The shell reads the persisted View preference before rendering when a Session first binds or a cached Session becomes current, activates the registered preferred View or Chat fallback, and activates later tab or focus selections before committing them to the store. A blank Session still omits the `conversation.view` slot; no unselected target is activated.

The resident composer survives no-Session and Session transitions. The no-Session state keeps the same composer surface mounted but inert while the Workspace picker connects a blank Session. The surface is a shell-owned Lexical editor: reference chips are atomic decorator nodes carrying the owner's serialization identity (submission expands them through the owner codec), claimed slash commands stay styled leading text, folder text references carry the folder glyph as an icon prefix, and the draft's clipboard projection is mirrored into the per-Session Conversation store. Queue operations address exact queue occurrences through the scoped `ctx.conversation` service; queue previews render sent text through the shared inline reference projection from `ui-primitives` (wire session forms fold to their label) and show local or durable images and files in original attachment order. Images use thumbnails; files use compact name-and-size cards. An edit exposes the literal sent text, and durable thumbnails resolve through the session image URL cache. Busy Enter behavior is stored in the Host-backed `ui-conversation` settings namespace.

Default sends commit optimistically: Enter clears the draft, occurrence table, and undo history in the same transaction, keeps the composer in `plain`, and runs the send as a detached attempt, so typing and further sends continue during the flight. `sendSession` registers a Session submission echo (`session.beginSubmission`) with the delivery mode before serializing, preserving selected image and file order in `pendingSubmissions`; Session derives the placement from that mode and its current running state, so idle sends use the transcript, busy Queue sends use QueueDock, and busy Steer sends use the pending-steering surface. It then yields one paint, encodes images through the browser's native `FileReader` data-URL path, and cites staged file receipts. Command submissions use the same receipts for generic files, so sending `/goal` or `/plan` never reads those browser files again. The prompt reuses the submission `requestId`; queue and history observation by that `rpcId` retires the echo once. Concurrent failures are restored together in submission order until the user edits the restored content; command submissions keep the frozen `submitting` phase. Detached attempts retain their attachment ids through admission and Session scope disposal. An observed retirement immediately exposes each image preview through the durable cache, replaces it with the canonical URL after fetching the admitted attachment, revokes each URL after its use ends, and releases file cards. Selected generic files enter one FIFO background-upload queue; `maxConcurrentFileUploads` defaults to two active Worker transports, the Conversation service retains queued and active operations plus byte progress across Session navigation, and removing a draft skips its queued transfer or aborts its active transport. Continuable subagents disable attachment intake and skip local echoes because their transport does not preserve the browser request id.

Queued submission echoes show “Sending…” beside disabled edit, remove, and steer buttons; a collapsed dock keeps the sending status in its header. A matching Host queue row replaces the echo and enables each action according to its normal text-content and running-state requirements. Prompt acknowledgement alone does not enable queue actions. A failed submission removes its echo and displays an error; the composer restores the failed draft when it is empty or still contains the previous automatic restoration, preserving subsequently typed text.

While a normal composer is running, its primary pointer action remains Stop when the draft is empty or input is unavailable. Actionable text or attachments switch the same seat to Queue Send; clearing or successfully submitting the draft restores Stop. The busy-Enter setting continues to select the Queue or Steer keyboard action. Plan mode and active goals do not change attachment intake. Continuable subagents keep separate Send and Stop actions but expose no paperclip, paste, or drop intake ([decision](../../../.agents/notes/implemented/bug-fix/2026-08-20-running-draft-primary-send.md)).

<a id="temporary-composer-entries"></a>
## Temporary composer entries

`conversation.composer` is a generic chain. Its complete owner currency is:

```ts type-equiv
/** Owner values used to elect a composer takeover. */
interface ComposerChainProps {
  /** Current Session identity used by temporary business-owned entries. */
  sessionId: SessionId | undefined
  /** Current Session lifecycle state, absent without a selected Session. */
  session: SessionSnapshot | undefined
  /** Effective business-owned interaction awaiting the user in this Session. */
  pendingInteraction: SessionPendingInteraction | undefined
}
```

A business package may install one entry only while a Remote waterfall request is pending:

```tsx
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChainSelect, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface Request {
  readonly sessionId: SessionId
}

type RequestComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: Request }

const select: ChainSelect<ComposerChainProps, Request> = owner =>
  owner.sessionId === request.sessionId ? request : null

const dispose = ctx.slots.register(
  { name: 'conversation.composer', select },
  RequestComposer,
)

try {
  return await request.result
} finally {
  dispose()
}
```

The selector must be a pure function of the owner currency. Its non-null return is delivered to the component as `matched`; `PropsRuntime<'conversation.composer'>` supplies the standard Session and global props. Chain order remains ascending `priority`, then registration order, and the first non-null selector wins. The shell keeps the default composer mounted beneath a takeover. Request state, listeners, response encoding, and any request-specific child slots belong to the business package; they are not carried by `SessionSnapshot` or declared by this core package.

<a id="model-experience"></a>
## Model Experience

None, as this package renders browser state and sends user-admitted inputs through Session Controller APIs without constructing model requests.

#### KV Cache effect

None; Conversation assembly and browser input state do not alter provider-side prompt caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only registered targets can render** — the shell deliberately has no implicit fallback target beyond the registered `chat` preference.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation Definitions, target builders, and Views are already validated by their owning registries and the Slot ledger.
