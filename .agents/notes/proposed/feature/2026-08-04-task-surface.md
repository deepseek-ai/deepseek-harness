# Agent Note: Task Surface for structured session interaction

Status: proposed

English | [中文](2026-08-04-task-surface.zh.md)

## Problem

Some tasks are awkward to finish through alternating prose messages. Comparing several options, reordering a plan, reviewing a table, or filling a small set of related fields all work better as one structured interaction. An agent can describe such an interaction, but it cannot ask the Web client to render one without adding a permanent product component or generating executable Client Plugin code.

Those two workarounds put ownership in the wrong place. Product-specific components require a new trigger and release for every task shape. Generated code has far more authority and lifecycle cost than a one-turn form needs. It also makes the presentation, rather than the user's conclusion, the durable artifact.

The missing contract is a bounded, replayable description of a temporary UI that belongs to one Session and one tool occurrence. The product should own validation, placement, interaction mechanics, and submission. The agent should own the task-specific copy, data, and choice of supported components.

## Proposal

Add **Task Surface**, a versioned declarative model rendered by a normal Web Client Plugin. One stable model-facing tool, `show_task_surface`, publishes the model. A successful call ends the current turn. The user edits and submits the rendered panel; the Host records the submission as one ordinary visible user message and starts the next turn.

Task Surface is the default structured-UI path when all of the following hold:

- the interaction belongs to the current Session and current task;
- its behavior fits the declared component set;
- it needs no background execution or new runtime authority; and
- the useful durable result is the user's submitted conclusion, not the panel itself.

This is one trigger, not a family of product heuristics. The agent calls `show_task_surface` explicitly. A user may ask the agent to use a Task Surface in ordinary language. Products do not inspect tool names or task topics to open bespoke panels, and repeated use does not automatically turn a Task Surface into a Plugin.

Short blocking questions remain with [`ask_user_question`](../../archived/feature/2026-07-29-ask-question-web-presentation.md). Plain explanation remains chat. Cross-Session navigation, background behavior, new services, or durable custom UI belongs to the Generated Client Plugin workflow.

## Declarative model

`TaskSurfaceModelV1` is JSON. It contains content blocks, input fields, and one submit label; it contains no code, callbacks, selectors, HTML, CSS, URLs to executable assets, or expression language. This type is unrelated to core Session's existing `SurfaceManager`/`SurfaceOp` message-reduction types; Task Surface is a product interaction protocol.

```ts
interface TaskSurfaceModelV1 {
  version: 1
  title: string
  description?: string
  sections: TaskSurfaceSection[]
  fields?: TaskSurfaceField[]
  submit: { label: string }
}

interface TaskSurfaceSection {
  id: string
  title?: string
  layout?: TaskSurfaceLayout
  blocks: TaskSurfaceBlock[]
}

type TaskSurfaceLayout =
  | { kind: 'stack' }
  | { kind: 'grid'; columns: 2 | 3 }

type TaskSurfaceBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'metrics'; items: { label: string; value: string; detail?: string }[] }
  | { kind: 'table'; columns: { id: string; label: string }[]; rows: Record<string, string | number | boolean | null>[] }
  | { kind: 'diff'; path?: string; before: string | null; after: string; language?: string }
  | { kind: 'notice'; tone: 'neutral' | 'info' | 'warning'; text: string }

type TaskSurfaceField =
  | { kind: 'text'; id: string; label: string; multiline?: boolean; required?: boolean; initial?: string }
  | { kind: 'choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string }
  | { kind: 'multi-choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }
  | { kind: 'toggle'; id: string; label: string; initial?: boolean }
  | { kind: 'order'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }

interface TaskSurfaceOption { id: string; label: string; detail?: string }
```

The renderer controls typography, spacing, responsive layout, focus order, keyboard behavior, and theme tokens. An absent layout means `stack`; a `grid` layout owns its column count and collapses when the available width cannot support it. Unknown versions or union arms use the generic tool-result fallback instead of partial interpretation.

The `markdown` block reuses `MarkdownText` with an explicit model-URL policy. `MarkdownText` gains `remoteImages: 'render' | 'alt-only'`, preserving `render` as its ordinary default; Task Surface always passes `alt-only`, so image syntax renders only its alt text. Raw HTML and embedded media remain omitted, automatic link previews are absent, and no model-supplied URL is dereferenced without explicit user activation. Ordinary HTTP(S) links may still navigate when the user chooses them. Fixed application assets such as syntax-highlighting chunks remain under the product's normal loading policy.

Version 1 deliberately omits conditional fields, client-side data fetching, charts, file uploads, and arbitrary event handlers. A new block or field kind is a protocol change with a parser, renderer, accessibility behavior, fallback, and replay fixture in the same change.

Limits are schema-backed configuration on the Task Surface service. The initial defaults are 64 KiB for the normalized model, 64 blocks, 32 fields, 200 table rows, and 32 KiB for a submission. IDs are unique within the model; field values must match their declarations; unknown fields are rejected. The limits bound log, DOM, and prompt costs without changing the protocol.

## Tool and presentation contract

`show_task_surface` accepts `{ model: TaskSurfaceModelV1 }`. The Host parses and normalizes the complete model, rejects the call when that Session already has an open Task Surface, mints `surfaceId`, and returns canonical `{ surfaceId, model }` with the normalized model. `presentationMeta` persists `value.model`, so the projector and executor cannot disagree about normalization. The Native result names the Surface and explains that an ordinary message bypasses it when the client cannot render the panel. The tool then calls `exec.concludeTurn()` so the agent does not continue past the requested human checkpoint.

The tool definition omits `isConcurrencySafe`. Under the existing tool-registry contract, omission classifies every call as an exclusive ordering barrier; no new `ToolDefinition` field is introduced. The tool is composed only in Web profiles that mount both the Host service and Web renderer. Version 1 supports `native` and `both` tool modes; a `ptc`-only profile does not advertise it because PTC mode dispatch is nested and cannot carry its presentation metadata to the outer result.

The browser-safe domain package imports the type-only `Branded` primitive from `@deepseek-ai/dsh-brand` and owns all three Task Surface IDs. The canonical value is execution-local under the [canonical tool output contract](../../implemented/architecture/2026-07-20-canonical-tool-output-contract.md). Replay therefore uses `output.presentationMeta(args, value)` to persist this tagged payload with `tool/result.meta`:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type TaskSurfaceId = Branded<'TaskSurfaceId'>
type TaskSurfaceSubmissionId = Branded<'TaskSurfaceSubmissionId'>
type TaskSurfaceDismissalId = Branded<'TaskSurfaceDismissalId'>

interface TaskSurfacePresentationMeta {
  kind: 'dsh/task-surface'
  version: 1
  surfaceId: TaskSurfaceId
  model: TaskSurfaceModelV1
}
```

The tool keeps a generic [render intent](../../implemented/architecture/2026-07-02-tool-render-intent-union.md). The keyed Web row reads the tagged metadata already retained on `ToolResultNode`; no new render-intent arm or presentation registry is required. Clients without Task Surface support render the ordinary result content.

The Web plugin has two static Session-scoped registrations under the [toolview](../../archived/architecture/2026-07-23-toolview-dissolution.md) and [slot registration](../../implemented/architecture/2026-07-22-slot-type-chain-implementation.md) contracts. A keyed `conversation.chat.toolview` entry for `show_task_surface` renders the durable transcript occurrence as a compact summary and read-only replay. One `TaskSurfaceDock` entry in the existing `conversation.input.dock` is the only actionable mount: it reads the active projection, calls `getActive` for the exact identity, and owns fields, drafts, submit, and dismiss. Because the Dock is independent of transcript pagination, an active Surface remains actionable when its `ToolResultNode` is outside the loaded history window.

The Dock follows the existing composer-chain fallback semantics. Any `conversation.composer` takeover hides the fallback composer stack, including `TaskSurfaceDock`, without unmounting it; the same draft owner reappears when the takeover resolves. A takeover does not receive Task Surface actions or create another editor.

The model does not choose a conversation tab, dock order, details column, modal, pixel position, or z-index. A later placement change remains a renderer decision and does not alter logged models. The transcript row never becomes a second editor, so one Surface cannot acquire competing draft or submission owners.

## Submission contract

The Task Surface domain exposes three operations through the Host transport. `submit` is the only one that admits a user message:

```ts ignore-check
type TaskSurfaceSubmissionPhase = 'queued' | 'claiming'

interface TaskSurfacePendingSubmission {
  submissionId: TaskSurfaceSubmissionId
  messageId: MessageId
  phase: TaskSurfaceSubmissionPhase
}

interface TaskSurfaceService {
  getActive(input: { sessionId: SessionId; surfaceId: TaskSurfaceId }): Promise<GetActiveTaskSurfaceResult>
  submit(input: SubmitTaskSurfaceRequest): Promise<SubmitTaskSurfaceResult>
  dismiss(input: DismissTaskSurfaceRequest): Promise<DismissTaskSurfaceResult>
}

interface SubmitTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: TaskSurfaceId
  submissionId: TaskSurfaceSubmissionId
  values: Record<string, JsonValue>
  note?: string
}

type SubmitTaskSurfaceResult =
  | { accepted: true; messageId: MessageId; phase: 'queued' }
  | { accepted: false; reason: 'not-open' | 'stale' | 'invalid-submission' | 'submission-pending' }

type GetActiveTaskSurfaceResult =
  | {
      active: true
      callId: ToolCallId
      surfaceId: TaskSurfaceId
      model: TaskSurfaceModelV1
      pending: TaskSurfacePendingSubmission | null
    }
  | { active: false; reason: 'not-open' }

interface DismissTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: TaskSurfaceId
  dismissalId: TaskSurfaceDismissalId
}

type DismissTaskSurfaceResult =
  | { dismissed: true; eventSeq: number }
  | { dismissed: false; reason: 'not-open' | 'stale' | 'submission-pending' }
```

The Host resolves the exact successful `show_task_surface` occurrence, revalidates the submitted values against its persisted model, and admits the response through the normal Session queue. The response becomes a user-role message with a merge-extensible source:

```ts ignore-check
interface TaskSurfaceCorrelation {
  version: 1
  submissionId: TaskSurfaceSubmissionId
  callId: ToolCallId
  surfaceId: TaskSurfaceId
  values: Record<string, JsonValue>
}

interface TaskSurfaceUserMessageSource {
  kind: 'user'
  rpcId: RpcId
  taskSurface: TaskSurfaceCorrelation
}
```

The `session/queue` wire item already carries the complete `Message`. The client projection is explicitly extended to retain its source instead of dropping the correlation:

```ts ignore-check
interface QueuedMessage {
  id: InboxItemId
  messageId: MessageId
  placement: 'queued' | 'steering'
  source: MessageSource
  content: readonly ContentBlock[]
  preview: string
  text: string | null
}
```

The browser-safe domain package owns `TaskSurfaceId`, the submission and dismissal IDs, `TaskSurfaceCorrelation`, and the pending-submission shape. ApiProxy owns the transport augmentation that combines the correlation with `rpcId`. Keeping `kind: 'user'` preserves the ordinary user bubble and prompt semantics while the extra field provides durable correlation. The message content is a product-formatted readable summary: panel title, labels and submitted values, plus the optional note. The model receives that same text. The structured source is not a second hidden instruction.

The product shell owns collapse and dismiss. Collapse is local view state and sends nothing. When no submission is pending, `taskSurface.dismiss({ sessionId, surfaceId, dismissalId })` appends one `task-surface/dismissed` Session event and does not start a turn; the exact event closes the projection and updates the Dock and transcript row. Retries reuse `dismissalId` and return the original result without appending another event. Dismiss is disabled while a submission is `queued` or `claiming`, and the Host rejects such a request with `submission-pending`.

Submission is transactional at the client boundary. Acceptance returns the exact `messageId` in phase `queued`; the Dock disables every mutation through both `queued` and `claiming` and clears the persisted draft only after the matching user message becomes durable. A rejection keeps the values editable and shows the returned reason. Double clicks and transport retries reuse `submissionId` and return the first result; another submission ID receives `submission-pending` while the first is live. The Host admits one user message for one accepted Surface.

The Task Surface service records accepted submission coordination as `pending.phase: 'queued'`, while the client can correlate the still-present queue row through its retained `source`. When the Agent dequeues that occurrence for ordinary prompt admission, the service synchronously changes the same pending record to `claiming` before ApiProxy publishes the ordinary queue snapshot without the claimed row. The service keeps that process-local claim across asynchronous admission and reconnect until a matching durable `user/message` is published or the Agent reports a terminal discard.

The matching `user/message` closes the durable projection and clears the claim. Rejection, cancellation, or disposal before durability reports the discard, clears the claim, and leaves the Surface open. The Dock never interprets queue-row disappearance as either outcome: it re-reads `getActive`; `pending.phase: 'claiming'` stays disabled, `pending: null` restores the draft, and `not-open` closes the Dock. `getActive` joins the log-derived active occurrence with this one process-local pending record. The record is coordination state, not a second durable authority; after a Host restart, an uncommitted claim is absent and the still-open logged Surface becomes editable again.

`session.updateQueue` rejects `edit` and `steer` for a Task Surface-correlated row. Editing would separate formatted content from its source-carried structured values, and steering would persist a `steering/message` that does not satisfy the submission lifecycle. `remove` is allowed while the row is queued; it reports the discard and restores the open Surface. Once claimed, the row has left the generic queue and queue mutations return `queue-item-not-found`. The Task Surface service holds one single-flight pending record until commit or discard.

## Lifecycle and recovery

The Session log is the authority. A small `taskSurface` unit in the existing [Session projection system](../architecture/2026-07-27-session-projection-and-command-log.md) folds successful surface result metadata and later user-message sources into this state:

```ts ignore-check
interface TaskSurfaceProjection {
  active: { callId: ToolCallId; surfaceId: TaskSurfaceId } | null
}
```

One Session has at most one open Task Surface. A successful result opens it. A matching Task Surface user message or dismissal event closes it. A later ordinary user message also closes it as an explicit bypass; another `show_task_surface` call fails until one of those events closes the active occurrence. Rewind and fork derive their active occurrence by folding the resulting log; transient queue phase is not copied, and no separate Surface database participates.

The full model remains on its `tool/result.meta`; the projection carries only the active identity. `TaskSurfaceDock` exists independently of history rows and reacts to that identity. `taskSurface.getActive({ sessionId, surfaceId })` reads the exact occurrence from the Session log, revalidates its metadata, joins the Task Surface service's pending coordination record, and returns `{ callId, surfaceId, model, pending }`. A missing or closed occurrence returns `not-open`. Refresh and reconnect therefore recover an actionable Surface and its same-process pending phase even when the result is outside the history tail, without copying the model into every projection baseline.

The Web plugin keeps unsubmitted values in a bounded, per-Session persisted slot store keyed by `surfaceId`; they never enter the Session log, prompt, or long-term memory. Submitted values live in the accepted user message, so losing a browser draft cannot erase a conclusion.

## Package boundaries and dependencies

The capability is split where ownership changes:

| Package | Responsibility |
|---|---|
| `packages/core/agent` and `packages/core/agent-loop` | Generic terminal outcome for a claimed next-turn inbox occurrence, allowing a Host observer to distinguish durable admission from discard without Task Surface-specific types |
| `packages/task-surface/task-surface` | Browser-safe model, branded IDs, correlation and pending types, parser, limits, submission validator/formatter, Session event extension, projection unit, and Host service contract |
| `packages/task-surface/tool-task-surface` | `show_task_surface`, canonical output, presentation metadata, generic render intent, active-Surface check, and `concludeTurn()` behavior |
| `packages/client/runtime` | Generic queued-message `source` projection and Session-scoped active-projection access |
| `packages/client/ui-primitives` | Task Surface-agnostic `MarkdownText.remoteImages` policy, including the `alt-only` image branch and URL-policy tests |
| `packages/client/ui-task-surface` | Static actionable `TaskSurfaceDock`, read-only keyed transcript row, declarative Web renderer that consumes the Task Surface model and `MarkdownText` in `alt-only` mode, per-Session draft store, and submit client |
| `packages/host/apiproxy` | Typed active-read/submit/dismiss transport, user-source augmentation and carriage, queue-action restrictions, and routing of claim and terminal outcomes; delegates validation, pending coordination, and admission to the Task Surface service |

`ui-task-surface` depends on the browser-safe Task Surface domain, client connection and runtime, locale, `ui-conversation` for the declared slot contracts, `ui-slots` for registration, and `ui-primitives`; `ui-primitives` does not depend on Task Surface. ApiProxy depends on the Task Surface service contract and the generic AgentLoop terminal outcome. Core Agent packages do not import Task Surface types.

The implementation depends on the existing message log, canonical tool output, tagged render intents, Session projection, per-Session declared slot stores, and slot lifecycle. It does not depend on runtime Client Plugin creation. The generated Client Plugin workflow may use Task Surface to present a review form, but neither protocol owns or activates the other.

## Delivery stages

1. Land the model/parser, `MarkdownText` model-URL policy, projection unit, `show_task_surface`, presentation metadata, read-only Web row, static `TaskSurfaceDock`, active retrieval, and generic fallback with read-only blocks.
2. Add fields, persisted drafts, Host-validated submit/dismiss, branded correlation, client queued-source carriage, Task Surface `queued`/`claiming` coordination, claimed-occurrence terminal reporting, queue-action restrictions, and visible user-message admission.
3. Add only component kinds justified by real tasks and two consumers or a clear generic fallback. A separate explicit user action may start the generated Plugin authoring workflow, but it creates a candidate; it never promotes code directly.

## Alternatives considered

**Add product-specific triggers and panels.** Rejected because every new task shape would couple agent behavior to a shipped product component. Product code should define one admitted component vocabulary and placement policy; the agent chooses among it explicitly.

**Render arbitrary HTML, CSS, or JavaScript from the tool call.** Rejected because it turns a temporary interaction into executable Client Plugin code without the build, preview, evaluation, approval, or rollback lifecycle that code requires.

**Extend `userInteraction.ask()` with a large form.** Rejected for this contract. `ask()` is a blocking request/response operation used when a running tool cannot continue without a short answer. A Task Surface ends the turn, may remain open across refreshes, and submits its result as the next visible user turn.

**Register one dynamic `conversation.view` per call.** Rejected because the view ledger is global while its render scope is per Session, and because transient job identity would become registration identity. One static Session-scoped Dock owns interaction, and one static keyed row summarizes the logged occurrence; neither registration uses occurrence identity.

**Keep the model only in the canonical tool value.** Rejected because canonical values are not persisted. Replay requires the normalized model in `presentationMeta`.

**Store the panel in long-term memory.** Rejected because layout and draft state are not the reusable fact. Memory may retain the submitted user conclusion under existing memory policy.

## Acceptance criteria

- A real model in `native` or `both` mode can call one stable `show_task_surface` schema, the call ends its turn, and a capable Web client renders the same normalized model live and after replay; `ptc`-only mode does not advertise it.
- The static `TaskSurfaceDock` is the only editor and remains actionable for an active result outside the loaded history window; the keyed toolview remains a read-only transcript summary and replay. A composer takeover hides the still-mounted Dock, preserves its draft, and reveals the same owner after release.
- Submitting produces exactly one visible user message per `submissionId`, starts the next turn through normal queue admission, and retains exact branded occurrence correlation while keeping `source.kind: 'user'`; dismissing records one log event and starts no turn.
- The queued client row retains the correlated message source. `getActive` exposes `queued` or `claiming` across same-process reconnect; commit closes the projection, while explicit discard clears pending state and leaves the Surface open. Queue-row disappearance alone changes no UI state. Edit and steer are rejected, and remove succeeds only before claim.
- Refresh, reconnect, Session switching, fork, and rewind produce the lifecycle state implied by the log; `getActive` recovers the model and pending phase outside the history tail, and no panel, pending state, or draft leaks across Sessions.
- Unsupported versions, malformed metadata, and absent client capability fall back to readable tool-result content with the ordinary-message bypass; nested calls and calls made while another Surface is active fail without opening a Surface.
- Wire schemas validate ID strings and domain APIs expose the branded ID types throughout. The model parser enforces tagged layout shapes, field values, and configured byte/count limits before the panel becomes actionable. Browser tests show image syntax becomes alt text, raw HTML and embedded media do not render, and no model-supplied URL is requested before explicit user activation.
- Keyboard-only operation, focus restoration, accessible names, narrow layouts, both themes, and zh/en product chrome are covered by component tests.
- Keyless browser composition covers show, Dock and read-only-row ownership, off-window recovery, edit, retry after rejected admission, queued-to-claiming transition, discard, durable handoff without an editable gap, forbidden queue actions, dismiss, reconnect, and double-submit idempotency.
- Prefix snapshots show one stable tool definition regardless of the task-specific model; only the call arguments and later user conclusion vary.
- Unloading the Web plugin disposes its Dock, row, and draft stores through the owning Fiber without changing the durable transcript.

## Risks

The first component set may be either too small for useful tasks or broad enough to become a weak application framework. Usage evidence should decide additions; the initial set has no expression language or network behavior.

The Task Surface Markdown policy gives up inline images, media, and automatic link previews. Ordinary links remain useful, but only an explicit user activation may navigate or start a request.

Large tables and Markdown can still create expensive DOM even inside byte limits. The renderer must virtualize or truncate where needed while preserving a readable fallback and explicit counts.

A product-formatted submission can become verbose when many fields are filled. The formatter needs a deterministic compact form and must preserve every submitted value without repeating the complete display model.

Holding a process-local claim until durable handoff adds a terminal-state invariant. Every admission exit must produce either the matching `user/message` or an explicit discard; otherwise a reconnect could retain a disabled Dock indefinitely.

Browser-local draft persistence can retain sensitive unsubmitted text. The store needs the stated byte bound, per-Session keys, explicit clearing after acceptance, and the same storage posture as the existing conversation draft.

The Dock and transcript row show the same occurrence in different roles. Keeping the row read-only and the Dock as the sole mutation owner prevents conflicting drafts at the cost of a second compact representation while the Surface is active.
