---
description: "Host and Client session control: create, resume, prompt, follow history, and project live session state."
kind: "package-reference"
---
# Session Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-session-controller` owns the Host `ctx.sessionController` service and the generated Client `session`, `skills`, and `fileReferences` Remote namespaces. It serves Session lifecycle and history, the Host-generation model catalog, human background-job kill, workspace-path opening, user-invocable skill discovery, and Agent-scoped file references. Use it through API Gateway when a Client needs operations addressed by a Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Client references](#client-references)
- [Session media references](#session-media-references)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

History pages and follow opening snapshots carry one `{ type: 'event', event: SessionWireEvent }` record per durable Session event. The Client retains each accepted record as one durable `SessionEventLikeEntry`; Assistant token boundaries remain inside the compact stream on `assistant/message` or `assistant/attempt`. Tool arguments, result content, failures, and `tool/result.data.meta` pass through unchanged; the controller does not resolve a Tool definition, run a presenter, or attach UI data.

The Client journal validates current Session event envelopes before publishing follow snapshots, live entries, or history pages. It reuses the browser-safe Session validators for required surface markers, exact replacement endpoints, earlier unique source seqs, embedded Assistant provider metadata, request-header omissions, and tool-error consistency. Invalid records fail without field stripping or normalization; range membership and source existence remain durable-log checks on the Host.

Each endpoint states its activation policy. List reads only stored headers and projection-cache rows: it never calls per-session stat or opens a cold Session body. A current-format cache identity may supply every list hint; a lifecycle-matching predecessor cache may supply only its version-compatible title as a stale display fact, never as an authoritative fold seed. Search, attachment, history pages, log following, skill discovery, and workspace-path opening can inspect persistence without activating an Agent; `canOpenWorkspacePath()` reports native-opening availability without addressing a Session. Cancellation requires live state; queue mutation, model, rename, prompt, and file-reference operations may resolve or resume an ordinary Session. Prompt rejects content with neither non-whitespace text nor an attachment before resolving the Agent or appending Session events; queue edits accept only non-empty text content. Prompt admission consumes opaque receipts from the injected [`fileUploads`](../../client/file-upload/README.md) Host service and resolves every same-Agent receipt before sending the complete ordered content list through `ctx.attachments`. Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message. Create and fork are the only operations that create a new Agent directly. The service applies one preset-aware resume policy and subagent ownership fence to its own methods and to the Typert Agent and Session lookups used by other Remote namespaces. Queue mutation has one narrow exception: a live child whose current projected identity is continuable and comes from its own non-seed suffix accepts the ordinary Edit, Remove, and QueueDock Steer actions across both inbox destinations. One-shot, missing, unknown, corrupt, seed-only, or cold children remain rejected without resume. The skill catalog uses a live Agent when present or the recorded preset's standing scope when cold, so listing never starts an Agent. The authenticated delivery routes use `workspaceDesktop()` for the serving Host name and file-manager behavior. `openWorkspacePath({ path, action: "reveal" })` delegates file-manager navigation to the native adapter; omitting `action` opens the file-type association, including HTML and SVG. Both operations require the composed filesystem to map the requested Host path to the same canonical process path; unmapped remote paths are refused before a native command runs. `session.projections` reads one complete baseline through a live-preferred Session observation without activating an Agent. It returns null for a missing Session and serves any registered projection keys. The Client exposes shared values and explicit-read state through `projectionsBySession`; domains select their own keys. Session-list summaries carry `agentAvailable`, updated through existing summary and status events independently of durable projections. Initial reads and live projection frames use the same sequence ordering.

Client list rows and resident Sessions use the current `sessionListMetadata` projection to reject stale blank-session hints; recency is the later of the summary timestamp and the projected last user prompt. When SessionManager creates an instance before its list row arrives, it reconciles blankness with metadata already retained for that Session. An opened conversation is therefore not reused by New Session even when an older list response still marks it blank.

Explicit-id `session.create` adopts a live Session or resumes a persisted Session while retaining its writer lock. Writer contention returns `session/writer-held`; callers may try another blank without suppressing unrelated failures. `session.list` includes persisted blanks using cached metadata, without opening cold log bodies.

Client list refreshes retain unchanged row objects and reuse the items array when order and values match. Each row's `retainedBy` contains positive local reference-source counts; Host metadata refreshes cannot overwrite them. Cache membership checks use a per-refresh ID set, so reconciliation grows linearly with the current list and retained cache sizes. Host summary updates replace running and Agent availability; local create/fork responses only fill missing metadata on existing rows. Removed ordinary Sessions retain projection stores only when their catalogs contain children.

Background-job rows and observation streams belong to [`dsh-api-job-controller`](../job-controller/README.md); the control stream carries projections only.

Projection reads retain loading and failure state independently of their values. Reconnect cancels reads from the previous connection and reloads previously requested projections; live membership updates arrive through the control stream. Parent availability comes from Host summaries and remains unknown until a summary or a successful list baseline establishes it. Address lookup resolves projected children without selecting them or creating scopes.

Accepted prompts and observed running keep their Client display conversion across list refresh, reconnect, and Session-object replacement. The Manager retains these observations by Session id; they do not establish durable history. Drafts, projection stores, and sidebar display rules retain their existing behavior. The [blank rollback decision](../../../.agents/notes/implemented/bug-fix/2026-09-15-client-session-blank-reconciliation.md) defines retention and late-response handling.

The Client adapter exposes `SessionEventStream`, a Gateway `RemoteJournalStream` bound to one ordinary or direct-subagent address. It opens follow before the initial page, publishes only contiguous `replace`, `prepend`, `append`, and `settle-assistant` changes, and repairs reconnect or sequence gaps through a tail page. Backwards paging has two verbs: `loadOlder()` pulls one Turn-aligned page, and `loadThrough(seq)` — the turn-jump loader — loops Turn-aligned pages until the window covers the target seq, lowering a shared target on repeated calls, stopping on a page that makes no progress, and reporting busy through the same `loadingOlder` snapshot bit. The Web adapter explicitly opts into cursorless Assistant frames: each opening carries the active attempt's `startedAfterSeq`, `nextIndex`, and compact stream, and every stream member becomes a Client-only `assistant/live-chunk` entry ordered between durable cursors. The Host captures a follower-local arrival ordinal with that baseline and suppresses buffered frames at or before the cut; a replacement Agent may restart frame revision at one. A durable `assistant/message` or `assistant/attempt` arriving after an active opening stays staged only when its seq follows `startedAfterSeq` and its Turn and Step match; the matching end type, seq, and index releases the durable entry. A successful message retains its transient rows until the owning `step/end`, so pending tool identities remain available for dispatch. Failed or interrupted settlements retire their rows immediately; earlier same-step retries remain visible. Revision, dense-index, or settlement gaps for a known attempt reopen follow, while a controller that missed the start ignores unknown-attempt frames and publishes their durable settlement normally. An abandoned end publishes a settlement delta without a durable entry so its transient rows retire immediately. A durable gap-repair page has no Assistant baseline, so its held notification reopens follow once for a paired page and baseline. Every history record covers exactly its event seq. A business, persistence, or unresolved continuity failure terminates the stream, while only physical carrier loss selects automatic resumption. `SessionControlStream` is a Gateway `RemoteSnapshotStream`; every generation opens with a complete process-local baseline, so reconnect replaces projection state instead of treating transient values as durable events. At each ready Host generation, a synchronous Client subscription clears retained projection values and watermarks before refreshing queries and restarting the control stream, including Sessions absent from the control baseline. The first control stream waits for generation readiness, so its opening values cannot precede invalidation. Outstanding list responses from the previous generation cannot republish those values. Within a generation, a delayed control baseline cannot overwrite or clear newer sequenced values, whether they arrived through a live Session's list block, a history page, or a frame; a cached list block, viewed from the projection cache for a cold Session, yields to the connected Session's baseline whatever watermark it carries. The durable `inbox` projection carries both pending lists through the same cold-read and reconnect path as other projections. Client Agent contexts provide the identity used by the independent [`fileUpload`](../../client/file-upload/README.md) service; Session objects expose lifecycle, prompt, queue, and history operations rather than file transfer.

The Session object also carries local submission echoes: `session.beginSubmission` inserts one into `SessionSnapshot.pendingSubmissions` synchronously, before the caller serializes and prompts, so a conversation UI can show the message on the submit click's own frame. The echo stores ordered image previews and durable file references. Session derives its `transcript`, `queued`, or `steering` placement from the current running state and requested delivery mode, then retains that placement until the display handoff. The prompt's `requestId` is the correlation identity: the Host echoes it as the durable user source's `rpcId`, including pending messages in the `inbox` projection. Queued echoes retire one animation frame after queue acceptance; Chat echoes follow the admission rule below. Identified failures and abandonment retire unadmitted echoes immediately. Disposal preserves observed admission and fails other unsettled submissions. Each retirement fires `onRetire` exactly once; an observed retirement includes the ordered durable attachment references so the composer can release successful cards while preserving failed drafts. Echoes are Client memory only; reload and reconnect rebuild the conversation from durable events alone.


During uninterrupted following, transcript and steering echoes stay in Chat through Inbox acceptance and claim until their durable messages arrive. After a local Chat message is admitted, its identity remains until the Inbox watermark reaches its next-turn or next-step claim seq: Chat already renders the durable Node, while Chat and QueueDock exclude matching stale Inbox rows. Other queued messages remain visible. A replacement follow baseline withdraws receipt-confirmed echoes as observed, using their accepted attachment references; unconfirmed submissions remain pending. Host data then supplies the pending or admitted rows. Reconnecting between claim and admission can briefly omit that bubble; withdrawal confirms acceptance, not execution or failure.

The user-invocable `skills/list` metadata includes the winning provider’s optional instruction-file `path`. The composer can preview that file without loading every skill body or activating a cold Agent.

Fork copies the exact inclusive event prefix selected by `atSeq`, including a cut inside an open turn. The child records its inherited marker before synthetic fork results and closing events. Omitting `atSeq` selects the latest completed turn and its standalone tail, stopping before the next turn or queued input; a nonexistent event is rejected. The chat action selects a completed turn.

A resume blocked by an existing write handle returns `session/writer-held` with the Session id; other resume failures retain `gateway/internal`.

`loadThrough(seq)` retains older pages privately until its shared target is covered or loading ends, then publishes the successful pages as one ordered prepend. Live events remain visible while history loads. A later page failure retains the successful prefix; replacing the history window discards buffered pages from the replaced window. Ordinary `loadOlder()` publishes one Host-selected page directly.

The Client's initial `follow`, reconnect openings, and `loadOlder()` request at least 50 append-origin `user/message` and `assistant/message` events and cross at least two `turn/start` events, including the partial Turn at the loaded window's beginning. The Host stops at the first Turn start satisfying both minima, or at 500 counted messages or history exhaustion, whichever comes first. Steering does not add a Turn boundary. Intervening events accompany the page without counting toward the message budget. The optional `turnWindow` on page and follow requests supplies these minima under `maxMessages`. `loadThrough()` uses the same rules with a 200-message minimum per page; the 500-message cap does not limit the whole jump. Requests without `turnWindow` retain message-aligned paging.

Queue edits replace pending content with non-empty text only.

Attachment authorization reads declared content fields of built-in Session events and completed assistant stream blocks, including flat V4 tool-role messages. Unknown event payloads and unrelated fields cannot authorize attachment reads.

The controller composes `ArchivedSessionGate` through `ctx.plugin`: it loads once the Agent registry, Session store, and Workspace registry exist and unwinds with the controller. Its `agent/pre-step` listener rejects a step proposed for an archived Session or for a subagent descendant of one — read from the Session header's lineage fields, never a fork — so a late waking delivery ends its turn as `blocked` without a model request; unarchiving lifts the gate for the whole lineage. The work an archived Session still runs is reported and stopped by its owners through the Workspace registry's archive admission ([seam](../../workspace/workspace/README.md)): the running turn by the [Agent registry](../../core/agent/README.md), owned jobs by the [job registry seam](../../jobs/jobs/README.md), subagent descendants by the [Subagent](../../subagent/subagent/README.md) runtime, reminders by the [Schedule](../../schedule/schedule/README.md) plugin; this controller reports nothing itself.

<a id="client-references"></a>
## Client references

`sessions.retain(target, { source, signal? })` immediately acquires one exact Client generation and starts its shared initial history opening. The target is a known Session id or a durable direct-parent subagent address; the Host validates an explicit address when history opens. The returned reference supports idempotent `release()` and `Symbol.dispose`; its `ready` Promise follows the shared `Session.open()` result and resolves to the exact binding when that attempt settles, including when a Remote failure is represented by `openState: 'error'`. It rejects when `Session.open()` rejects, its waiter is cancelled, or the reference is released early. Cancelling one waiter does not cancel another owner's opening. `sessions.using(target, options, operation)` waits for that settlement, holds its reference until the callback settles, and propagates rejected readiness and callback failures.

References keep local Session data, scoped Contexts, and history streams alive, not Host Agents. Ordinary Session retention never adds a catalog row. Retained subagents with a known direct-parent address keep a fallback row and notify list readers even before the parent catalog arrives; these rows do not join Host-list membership. Fork-title assignment sends rename directly and applies the returned title projection without retaining the child or opening its history. Final release withdraws the generation before teardown; later acquisition can create a new generation with the same id. `binding(id)` and `scope(id)` only borrow an existing generation. `retainInfo(id)` observes stable read-only source counts independently of catalog membership and performs no history I/O. Consumer source keys are declaration-merge extensible; navigation and completion acknowledgement belong to UI consumers, not this Controller. See [Client Session references](../../../.agents/notes/implemented/architecture/2026-09-15-client-session-references.md) for ownership and teardown rules. An unknown-mode subagent address permits history reads with direct-parent validation. Successful descriptor restoration determines the displayed mode; failures remain local to the child, and control requests still require a confirmed continuable identity.

<a id="session-media-references"></a>
## Session media references

`SessionMediaReferences` mounts `GET|HEAD /api/file?path=<absolute path>` on the authenticated `connection.fetch` channel when `connection`, `fs`, and `attachments` are composed. It reads ordinary files through `ctx.fs`, including temporary paths outside registered workspaces and files in remote providers. Neither directory containment nor MIME categories restrict access; `mime-types` supplies the response type, with `application/octet-stream` for unknown extensions. GET reuses `readBytes` for preflight and ongoing byte limits; HEAD reads metadata only. All files use `ctx.attachments.imageLimits.maxImageBytes` (normally 20 MiB); exceeding this limit returns 413. Responses contain the complete file, ignore Range, and carry `private, no-store`, `nosniff`, and a sandbox CSP so directly opened HTML/SVG cannot execute with the API origin. The Client rewrite lives in `ui-chat` (`AssistantMarkdown`); audio/video responses are available, while Markdown audio/video player nodes remain separate work.

GUI model selection requires the exact provider/model pair in the available catalog; unavailable choices reject with `session/model-unavailable`. Prompt admission retains the saved route without a catalog availability gate, so request execution reports missing credentials or unavailable models. `initializeDefaultModel()` saves the first available account model after login when no other provider has a configured API key; credential checks use configured references independently of model availability. A provider with no available models rejects initialization with `session/provider-models-unavailable`. Availability never substitutes another model or rewrites a Session selection.

A successful `selectModel` response acknowledges the Session-local selection without waiting for the default profile setting to save. Default saves run in the background in submission order; a failure logs a warning and leaves the Session selection intact. New Sessions read the last successfully saved default.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `nativeOpen` | platform-detected | Whether Session workspace paths can be handed to a native desktop opener |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-session-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as invoked Agent commands own any model-visible effect.

#### KV Cache effect

No direct effect; model requests remain owned by the Agent and LLM packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The image byte cap does not validate decoded dimensions or pixel count.
- A failed follow resumption remains visible to the caller instead of retrying indefinitely.
- The raw browser upload is one streaming HTTP request without resumable offsets; a retry sends the file again from byte zero.
- File-reference completion uses the shared Agent lookup and can resume a cold Session; the `skills/list` catalog is the non-activating alternative for skill metadata.
- Accepted/running display memory lives only in Client memory and is lost on page reload.
- That memory is not shared between tabs: one tab can show a converted row while another still shows `New Session` for the same Session.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Every page and frame is checked against the addressed durable Session.
