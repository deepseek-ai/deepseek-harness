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

`UiConversation.events` is the single registry for event Definitions, and `UiConversation.views` is the single registry for target snapshot builders. Both registries reject duplicate keys, preserve registration order, return idempotent disposers, and rebuild existing bindings when their contribution roster changes. `UiConversation.binding(bindingOrSessionId)` returns one identity-stable Conversation binding for the current Session Controller binding. It does not open another event source. A View Definition may declare `toolCallFocus` to translate a tool-call id into its focus identity. Conversation supplies an Inspect callback only while such a target has a visible View entry; Chat consumes this callback without selecting a target.

`ConversationBinding.openTurn` is an identity-stable, read-only source of the latest turn number when its start is loaded and it remains open, or `undefined` otherwise. Observed turn changes publish synchronously even when no View is active. Fixed stop input reads this source alongside Session running and pending-interaction state. Unloading the Session binding detaches its event-source subscription.

The adapter passes each `SessionEventLikeEntry` directly to the assembler. Its outer `type` distinguishes durable events from Client-only transient events, while its inner `event` always exposes `type`, `seq`, `time`, and `data`; Definitions receive that inner `SessionEventLike`. Replacement windows may include both entry variants, while historical prepends carry durable entries and live appends may carry either. Definitions use the same match/start/update interface for durable and transient events. The earliest loaded start initializes State; every later Match, including another start for that identity, updates it. Definitions that do not consume Assistant deltas return `null` for `assistant/live-chunk`. Replacement windows and revision gaps rebuild from the complete loaded window; contiguous append, prepend, and Assistant-settlement revisions use incremental assembly. Settlement removes only the named attempt's transient matches, applies its optional durable entry, and recomputes the affected Contexts from their remaining earliest start, refreshing predecessor indexes and dependents without replacing unrelated target nodes. A Context with no remaining start has no State. Its key and previously published nodes remain available to later evidence until a full window rebuild; the owning Definition may hide those nodes. The assembler owns Context matching, Turn/Step locations, target node materialization, target activity, and stable target sources. `ConversationSnapshot` contains only target-neutral views and active-target facts; Session lifecycle state remains in `SessionSnapshot`.

A target becomes active when shell selection resolves it or when its source receives a first subscriber. The assembler replaces that target from current Contexts once and keeps it active for later incremental flushes; creating a source does not activate it and unsubscription does not deactivate it.

`UiConversation.groups` registers one optional business Group Definition per existing target. It consumes projected Node changes, changed Turns, and indexed target positions after Node materialization, including first activation, and owns all segmentation and group data. Indexed Turn reads preserve interruptions from neighbouring Nodes, allowing business updates to stay within affected Turns and groups. The assembler validates and installs root references and keyed group snapshots before publishing Node, Group, and Location data sources. Ungrouped targets retain their original path. [Grouping](../../../docs/subsystems/conversation.md#group-definitions) defines input lifetime, typed registration, atomic updates, and renderer responsibilities.

Group registration rejects a missing View target. Removing an already registered View Definition pauses its grouping and clears its published results without removing the Group Definition; registering that View again rebuilds from the current loaded timeline through the existing replacement flow. Switching View tabs does not remove a View Definition.

Target packages declaration-merge their snapshot and Location data maps, then register with `ctx.uiConversation.events.register(...)` and `ctx.uiConversation.views.register(...)`. A target reads its Session-owned source with `ctx.uiConversation.binding(binding).target(targetId)`. Registrations are Cordis effects and their returned disposers remove the contribution from the same registry. The shared request inspection serves every target: `ctx.uiConversation.inspectSystemPrompt(previous, event)` interprets system messages and positional replacements as immutable loaded-surface state. It selects the last nonempty surviving system node in surface order, retains only surviving replacement positions for chained rewrites, and withholds the prompt after an unindexed older endpoint until prepend replay supplies its order. Target-owned Definitions retain historical cards independently. `ctx.uiConversation.inspectRequestPrompt(previous, header, system)` classifies request changes against that effective prompt; ordinary messages and stream chunks require no system-state work.

<a id="shell-and-standard-props"></a>
## Shell and standard props

The shared image slot props keep display choices separate from durable references: `thumbnail` requests a contained attachment-list thumbnail, while `compact` requests a cropped gallery tile. An optional per-image `label` supplies the accessible display name; loading and cache identity still use the original attachment reference. [ui-attachment](../ui-attachment/README.md) owns rendering and the lightbox.

The composer measures its expanded control groups after size, content, visibility, or font-loading changes. If they cannot share a line, the row sets `--dsh-composer-model-text-display: none` and `--dsh-composer-model-icon-display: block` for the model seat; their defaults are `block` and `none`. Wrapping remains available if even the icon cannot fit.

The context-occupancy button shows a ring and percentage below the input card, after the Session statistics. Clicking it opens the token breakdown in a panel kept inside the viewport, including when no statistics are shown; the button stays hidden until context usage and capacity are available.

With Coding Tools off, the shell hides only Trajectory; other plugin-contributed Views remain available. The View tab bar is hidden when fewer than two Views are available. Turning Coding Tools off while Trajectory is active returns to Chat; stored View preferences and recorded Session data remain intact. Turning it on makes Trajectory available again. View owners receive the available roster so their navigation actions can follow the same visibility.

The composer registers the File command action and owns its label, availability, and native file-dialog callback. Menu availability and invocation both consult the mounted composer's current attachment-intake policy. Unmounting or locking the composer disables that action; disposing the plugin removes its registration. The callback binding stays inside the input module.

`SessionInputShell` owns one Lexical editor per Session through its private [DraftEditorRuntime](src/client/input/editor/runtime.ts), while retaining submission, attachment selection, and recovery decisions. [DraftEditor](src/client/input/editor/DraftEditor.tsx) renders the borrowed editor; InputBar retains its Hooks and refs and installs DOM behavior through [view-binding](src/client/input/editor/view-binding.ts). Editor-facing types live in [draft-editor.ts](src/client/contract/draft-editor.ts), with shared input and submission types in [input.ts](src/client/contract/input.ts). Background editor updates retain the draft selection without changing the document selection or reclaiming focus from another control; explicit Composer focus restores its selection. This separation does not support simultaneous editable roots for one Session; [the two-stage isolation proposal](../../../.agents/notes/proposed/architecture/2026-09-14-composer-model-and-draft-editor.md) defines the remaining work.

Claimed commands retain their identity and highlight when only their arguments and trailing separator are deleted; editing the command name releases the claim. The same rules apply to every command and locale, including `/goal`, `/目标`, `/plan`, and `/计划`. Command hints and ordinary placeholders remain hidden throughout IME composition and reappear only after the editor commits the final text and the corresponding input is empty.

Workspace selection uses `uiWorkspace.openWorkspace` to prepare the target and commit navigation. Draft text and attachments move in its synchronous preparation callback only while that request is current; later navigation or owner disposal leaves the original draft intact.

The package occupies the root-scoped `main` key `conversation`. Its `main.conversation` shell keeps the resident `conversation.header` outside the optional-Session `conversation.content` Component Factory. The header hosts root-scoped navigation without a selected Session; titles, actions, and View tabs remain in its strict Session child. The Factory owns the shared body and Composer, reads the current Session through its standard Hook, and exposes strict-Session `views` plus root-scoped `widthControls` local positions. Its default adapter renders the existing `conversation.session` entry, while the main occurrence selects the width handles; an embedded occurrence can replace `views` and omit those handles without rendering the main Header. The shared body and Composer register the queue and Todo docks. The Todo dock uses the shared panel elevation above the composer; its rows use the shared idle, ongoing, and done markers for pending, in-progress, and completed items. `ctx.uiSession.provide()` materializes the Conversation and input sources from the same Session binding and supplies `inputActions` as a stable standard prop.

A blank Session retains the header's leading and corner controls, including the right-sidebar opener, while hiding its title, actions, utilities, and View tabs. Selecting a Workspace creates the Session needed by these controls; the first message is not required. Without a selected Session, the strict header is absent; the resident header keeps a 40px window strip on macOS desktop that it owns as its drag row, and no empty vertical space on Web, Windows, or Linux. Sidebar entries retain their own data and execution prerequisites. A started Session header uses one row when fewer than two Views are available; the tab row reserves space only while rendered.

View selection is deterministic: a registered persisted selection wins, otherwise registered `chat` wins, otherwise no View renders. It never chooses the first registered View. Shell phase combines Session lifecycle with the active-target set; no target-specific snapshot is read by the shell.

The shell reads the persisted View preference before rendering when a Session first binds or a cached Session becomes current, activates the registered preferred View or Chat fallback, and activates later tab or focus selections before committing them to the store. A blank Session still omits the `conversation.view` slot; no unselected target is activated.

Active transcripts in the main occurrence expose content-width drag handles in their uncovered side gutters; embedded occurrences omit them. A View that paints into a gutter raises only its concrete painted element above the handle; transparent full-width wrappers stay below so they do not claim empty gutter. This requires the path between that element and the Conversation body to remain outside an intermediate stacking context; the shipped Chromium behavior is pinned by the browser scenario. Chat applies the rule to table elements, while its column-bounded tool cards need no raise. Wheel motion over a handle still scrolls the transcript, while Ctrl+wheel remains a browser zoom gesture. The sticky composer intentionally owns its full footer band, which is not a resize target; an already-captured drag lifts its indicator until release ([handle styles](src/client/skeleton/ConversationRoot.module.css)).

The width-handle indicator follows the pointer only during a captured drag; ordinary hover leaves its position unchanged.

The resident composer survives no-Session and Session transitions. Whitespace hides its placeholder; a whitespace-only draft without attachments cannot be sent. The no-Session state keeps the same composer surface mounted but inert while the Workspace picker connects a blank Session. The surface is a shell-owned Lexical editor: reference chips are atomic decorator nodes carrying the owner's serialization identity (submission expands them through the owner codec), claimed slash commands stay styled leading text, folder text references carry the folder glyph as an icon prefix, and the draft's clipboard projection is mirrored into the per-Session Conversation store. QueueDock reads `next-turn` from the Session `inbox` projection, including cold recovered messages, and excludes only requestIds still owned by local transcript submissions. Other queued rows retain their normal display and actions. Queue operations address exact queue occurrences through the scoped `ctx.conversation` service; queue previews render sent text through the shared inline reference projection from `ui-primitives` (wire session forms fold to their label) and show local or durable images and files in original attachment order. Images use thumbnails; files use compact name-and-size cards. An edit exposes the literal sent text in a textarea that grows with its content, so line breaks survive re-editing; Enter saves, Shift+Enter breaks the line, and Escape cancels. Durable thumbnails resolve through the session image URL cache. Busy Enter behavior is stored in the Host-backed `ui-conversation` settings namespace. The composer keymap arbitrates the trigger menu's keys through the slash pipeline — Tab settles the highlighted completion (or drills a drillable one), Escape and Shift+Tab leave the menu without settling — and leaves every other key to the editor. An overlay that takes the keyboard hands it back through `SessionInput.focus()`, which rides Lexical's own focus so the caret returns where the draft left it rather than at the start.

Plain Enter uses the configured delivery mode, exactly Ctrl+Enter or Cmd+Enter uses its complement, and Shift+Enter inserts a line break. Enter with Alt, AltGraph, both Ctrl and Cmd, or Shift plus Ctrl/Cmd leaves the draft and command menu unchanged and keeps the DOM event available to application shortcuts. The Conversation plugin registers the fixed send, newline, complementary-delivery, command-menu, and reference-menu rows and reserves their bindings until it unloads.

Default sends commit optimistically: Enter clears the draft, occurrence table, and undo history in the same transaction, keeps the composer in `plain`, and runs the send as a detached attempt, so typing and further sends continue during the flight. `sendSession` registers a Session submission echo (`session.beginSubmission`) with the delivery mode before serializing, preserving selected image and file order in `pendingSubmissions`; Session derives the placement from that mode and its current running state, so idle sends use the transcript, busy Queue sends use QueueDock, and busy Steer sends use the pending-steering surface. It then yields one paint, encodes images through the browser's native `FileReader` data-URL path, and cites staged file receipts. Command submissions use the same receipts for generic files, so sending `/goal` or `/plan` never reads those browser files again. The prompt reuses the submission `requestId`; Session retires the echo once at its display handoff, correlated by that `rpcId`. Concurrent failures are restored together in submission order until the user edits the restored content; command submissions keep the frozen `submitting` phase. Detached attempts retain their attachment ids through admission and Session scope disposal. An observed retirement immediately exposes each image preview through the durable cache, replaces it with the canonical URL after fetching the admitted attachment, revokes each URL after its use ends, and releases file cards. Selected generic files enter one FIFO background-upload queue; `maxConcurrentFileUploads` defaults to two active Worker transports, the Conversation service retains queued and active operations plus byte progress across Session navigation, and removing a draft skips its queued transfer or aborts its active transport. Where the browser shell exposes `__DSH_HOST_PATHS__` (the Desktop application), dropped or pasted folders and dropped, picked, or pasted non-image files with a real path become `@path` chips; images keep uploading. Drag-and-drop and paste identify directories through the browser entry API; when that API is absent or returns no entry, pasted items retain ordinary file handling. The file picker cannot select directories. References require the `ui-reference` plugin and the original paths to remain readable by the model's file tools. Paths inside the workspace are relative; others remain absolute. The whole batch is validated before insertion, retains source order and selected text, and uses whitespace-separated, closed-quote mentions. A browser without the bridge refuses dropped or pasted folders; a Desktop folder without a reported path is rejected separately. Continuable subagents disable attachment intake and skip local echoes because their transport does not preserve the browser request id.

Queued submission echoes show “Sending…” beside disabled edit, remove, and steer buttons; a collapsed dock keeps the sending status in its header. A matching Host queue row replaces the echo and enables each action according to its normal text-content and running-state requirements. Prompt acknowledgement alone does not enable queue actions. A failed submission removes its echo and displays an error; the composer restores the failed draft when it is empty or still contains the previous automatic restoration, preserving subsequently typed text.

Disabled Send and Stop buttons suppress their tooltips, including a Stop button that becomes a disabled Send button when the turn ends. While a normal composer is running, its primary pointer action remains Stop when the draft is empty or input is unavailable. Actionable text or attachments switch the same seat to Send; clearing or successfully submitting the draft restores Stop. The busy-Enter setting selects the Queue or Steer delivery for ordinary Sessions and continuable children, and the running Send button delivers through the same mode plain Enter resolves to; while it is enabled (no upload pending) over a plain message draft its label names that mode (Queue message or Steer message), so the setting governs Enter and the button together while Cmd/Ctrl+Enter still uses the other mode, and idle sessions, empty drafts, and `/` command lines keep the plain Send label ([decision](../../../.agents/notes/implemented/bug-fix/2026-09-04-busy-send-button-follows-enter-setting.md)). Their QueueDock rows share Edit, Remove, and Steer, and an empty draft shares the steer-all chord. One-shot children remain read-only. Plan mode and active goals do not change attachment intake. Continuable children keep separate Send and Stop actions but expose no File row, paste, or drop intake; if their parent is offline, Send and the composer gestures lock while QueueDock controls for the live inbox remain available ([decisions](../../../.agents/notes/archived/bug-fix/2026-08-20-running-draft-primary-send.md), [inbox controls](../../../.agents/notes/implemented/feature/2026-08-27-continuable-subagent-human-inbox-control.md)).

File chips and editable skill references share a whole-reference hover background and follow the composer's line height and text baseline. The first click delegates preview opening to the registered reference source immediately, including the first click of a double-click sequence. Subsequent clicks retain native text selection; an existing noncollapsed selection suppresses pointer preview activation. Previewing does not change the draft, its clipboard projection, or submission.

When another writer owns the Session, the send-error toast asks the user to quit other running DSH instances and retry.

Two independent Escape presses in the focused Chat or Composer stop its current running turn and preserve queued messages. The interval comes from the shortcuts plugin’s `stopSequenceMs` configuration (500 ms by default). A menu, approval, modal, terminal, embedded webpage, composition, repeated key, changed input region, Session or turn breaks the sequence. The shortcut uses the same scoped cancellation as the Stop button. The plugin registers Stop as a fixed action in the `input` display group. Its registration reserves plain Escape against editable shortcuts and supplies the `Esc Esc` sequence shown in the Stop button’s hover and keyboard-focus tooltip.

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

`InputActions.captureInsertion()` captures the draft selection and revision; `insertText(text, span)` inserts one undoable plain-text edit only while that revision is current and the editor permits editing. Asynchronous consumers retain rejected results for user action.

`conversation.input.activity` hosts one control between the model selector and Send. Its `onActiveChange` callback expands that control across the toolbar and hides ordinary accessory controls and the context meter while preserving the editor and submit action. Closing the activity restores those controls with context details closed. The empty hero dock remains collapsed when it has no content. The occupant releases expansion on unmount and owns any activity-specific feedback.

<a id="model-experience"></a>
## Model Experience

None, as this package renders browser state and sends user-admitted inputs through Session Controller APIs without constructing model requests.

#### KV Cache effect

None; Conversation assembly and browser input state do not alter provider-side prompt caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only registered targets can render** — the shell deliberately has no implicit fallback target beyond the registered `chat` preference.
- **Factory occurrences inherit their render-position Session** — `conversation.content` does not accept an independently addressed Session; that requires a separate Session-provider capability.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation Definitions, target builders, and Views are already validated by their owning registries and the Slot ledger.
