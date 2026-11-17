# Agent Note: Import DeepSeek website chat exports

Status: implemented

English | [中文](2026-11-11-deepseek-chat-export-import.zh.md)

## Problem

The "export all chats" action on the DeepSeek website (chat.deepseek.com) produces a `deepseek_data-*.zip`. Users want to bring these conversations into DSH and keep using them: browse the original questions, reasoning, and answers in the Web GUI, and continue any conversation with the model seeing its original context. Without an import, DSH can only start from a blank Session.

The export format (`export_format_version: 3`) differs from a DSH Session in four structural ways that the import must handle:

- Each conversation's `messages` form a tree linked by `parent_id` (regenerating a reply or editing a question creates a branch); a DSH Session is a linear append-only log.
- Message `id` values increase only within one conversation and cannot be compared across conversations; `inserted_at` is not monotonic even within one conversation (an assistant reply is often a few milliseconds earlier than its user message).
- The `fragments` of one assistant message interleave reasoning, web search, opened pages, and answer text; DSH expresses the same process with `assistant/message` plus `tool/call` / `tool/result` inside steps.
- The export also contains template replies, failure states, encrypted link bodies, and notices that must **not** enter the model context.

One export can contain thousands of conversations and hundreds of megabytes of images; users need only the most recent conversations, in a Workspace they choose, and the Host must stay responsive while it imports them.

## Decision

The experimental package [`@deepseek-ai/dsh-deepseek-chat-import`](../../../../packages/experimental/deepseek-chat-import/README.md) has a Host face and a Client face:

- Host face: a `TypertRemoteService` that registers the exact upload route `POST /api/deepseek-chat-import/archive?workspaceId=…` on `ctx.connection.fetch` and the `@Remote limits()` method. The route buffers the uploaded ZIP in memory, imports the most recent conversations one at a time as stored DSH Sessions in the chosen Workspace, and streams progress.
- Client face: an import button right of "New session" in the sidebar. It opens a dialog with an export file field (the browser-native file input, `accept=.zip`) and a Workspace field that renders the `workspace.picker` Factory from ui-workspace; the browser uploads the file and shows upload and import progress and the result.

The button position comes from the ui-sidebar HOC slot `sidebar.session.action`; the plugin wraps the New-session row content there and returns it followed by its button, so decorating the row adds no wrapper element. ui-sidebar does not hard-code the button, because the sidebar shell would then call the import plugin's Remote namespace and carry business logic. The Workspace field reuses the New-session Workspace menu as the `workspace.picker` Factory: existing Workspaces plus "Add workspace…", which runs the composed directory picker through the `workspace.picker.directoryFlow` hole.

The capability ships as an Official experimental optional bundle: the package declares `dsh.bundle.patch` with its own `deepseek-chat-import` row, is listed in `OPTIONAL_BUNDLES`, and is switched off until the user enables it on the Plugins page. The default Web composition does not mount it.

### User flow

1. The user enables "DeepSeek chat import" on the Plugins page, then clicks the import button right of "New session" (an icon button below the "New session" icon in the narrow sidebar). Only the owner sees the button.
2. The dialog takes the ZIP file exported from the DeepSeek website (`deepseek_data-*.zip`) and the Workspace that receives the Sessions. The Workspace field preselects the current Session's Workspace; "Add workspace…" adds a new directory through the directory picker.
3. On import, the browser first calls `limits()`; a file larger than `maxUploadBytes` is rejected before upload. A served page then shows the upload percentage, an indeterminate phase while the Host reads the archive, and "Importing n/K" while Sessions are written. A page whose Host runs in another execution context carries the archive over `__DSH_TRANSPORT__.fetch`, which reports no byte progress, so the dialog starts at the reading phase. Closing the dialog aborts the request.
4. On success the dialog shows how many Sessions were imported into which Workspace, how many conversations exceeded the limit, and how many could not be imported, in singular or plural form.
5. On failure the dialog shows the localized explanation of the failure reason, or the message of an unexpected error.
6. However the attempt ends, the browser refreshes the Session list, so Sessions written before a failure or cancellation appear.

The user then opens any imported Session and sees the original questions, reasoning, search cards, and answers; a new message continues with the default model and the imported history as context.

### Package layout

| File | Responsibility |
|---|---|
| `src/types.ts` | Browser-safe wire types only: results, failure reasons, limits, the NDJSON answer lines, and the `deepseekChatImport/owner-only` Remote error code |
| `src/protocol.ts` | `UPLOAD_PATH` and its document-relative form `UPLOAD_ROUTE` |
| `src/format.ts` | zod validation of `manifest.json`, `chat_sessions/{id}.json`, and the fragment types the package maps; unknown fragment types stay for the converter to ignore |
| `src/archive.ts` | `openExportArchive(bytes, maxEntryBytes, signal)`: the ZIP central directory, streaming passes over the archive bytes that inflate only the entries they are asked for, and a by-name read |
| `src/conversation.ts` | Pure functions `selectBranch(file)` and `convertConversation(file, options)` from a message tree to seed events |
| `src/importer.ts` | `importDeepseekChatExport(deps, request, signal)`: index selection, the image pass, the conversation pass, writes, and Workspace attachment |
| `src/upload.ts` | `createUploadRoute(handler)`: request validation, bounded buffering, the streamed answer, and cancellation |
| `src/index.ts` | `DeepseekChatImportService`, `Config`, the single import slot, and `@Remote limits()` |
| `src/client/*` | Button, dialog, browser upload over the page carrier or XHR, locale dictionaries, slot registration |
| `cordis.patch.yml` | The optional bundle row `deepseek-chat-import` |

`src/conversation.ts` reads no files, uses no services, and reads no clock; the caller injects every id, so it is deterministic under unit tests. `src/importer.ts` uses persistence, the projection cache, attachments, and the Workspace registry through an explicit dependency object, so its tests can use real JSONL persistence.

### Host route and Remote

```ts
/** Deployment limits of the importer. */
interface Config {
  /** Most Sessions one import writes, choosing the conversations the export index lists as most recently updated; default 1000. */
  maxSessions: number
  /** Largest export archive, in bytes, one upload may carry; default 512 MiB. */
  maxUploadBytes: number
  /** Largest declared uncompressed size, in bytes, of one archive entry; default 256 MiB. */
  maxEntryBytes: number
  /** Largest UTF-8 size, in bytes, of an imported title; default 80. */
  maxTitleBytes: number
}
```

`POST /api/deepseek-chat-import/archive?workspaceId=…` is an exact route on the shared API channel, so only owner Peers reach it. `limits()` refuses every caller that is not the owner with `deepseekChatImport/owner-only`, so a non-owner principal such as a shared-Session guest never imports. The route requires `content-type: application/octet-stream` (otherwise 415) and a non-empty `workspaceId` (otherwise 400); the shared handler answers other methods before the route runs.

The service owns one import slot. A request takes the slot or answers `busy`, resolves the Workspace (`workspace-not-found`), and reads the streaming body into one buffer sized from a valid `content-length`, growing it only when the body is longer than declared, until the body ends or exceeds `maxUploadBytes` (`too-large`). The upload is never written to disk. Each request owns an AbortController joined with the request signal and with cancellation of the response body. Unloading the plugin aborts the running import, including a body still uploading, and completes only after the import stops writing.

The answer is `application/x-ndjson` with `cache-control: no-store, no-transform`: progress lines `{ type: 'progress', done, total }`, then exactly one line `{ type: 'outcome', outcome }`, where `outcome` is `{ ok: true, value: DeepseekChatImportResult }` or `{ ok: false, error: { reason, message } }`. The Web server writes the body chunk by chunk, and the browser reads complete lines as they arrive, which also works when a proxy delivers the whole body at once. The browser validates every decoded line: it must be an object of a known `type` with the fields that type carries, so a `null`, a line missing `done`, or an outcome whose `ok` is not boolean fails the answer as invalid instead of throwing inside an `onload`/`onprogress` callback. `reason` is one of `too-large | unreadable-archive | missing-manifest | missing-index | unsupported-version | no-conversations | workspace-not-found | busy`. An unexpected failure is logged on the Host and ends the body without an outcome line, which the browser reports as an upload failure.

`attachments` and `sessionProjectionCache` are optional services read through `ctx.get()`: without the attachment service, images become synthetic file cards; without the projection cache, the list row of a cold Session cannot show its original title and activity time before it is first opened.

### Reading the export

- `openExportArchive` reads the central directory with fflate's asynchronous `unzip` and a filter that accepts nothing, so opening inflates no entry. Bytes that are not a readable ZIP fail with `unreadable-archive`. Entry names must be unique: a by-name read selects by name, so a duplicate name would inflate every match and bypass the per-entry limit; a duplicated name fails with `unreadable-archive`. Duplicate detection covers the central directory only: a second local file header renamed to an existing entry name is not detected, so the pass can deliver more conversations than the index lists, and the import does not guard the write count.
- `manifest.json` and `chat_session_index.json` are read by name before the pass. A missing or damaged manifest fails with `missing-manifest` or `unreadable-archive`; a missing, damaged, or unparsable index fails with `missing-index`; an entry over `maxEntryBytes` fails with `too-large`; an `export_format_version` other than 3 fails with `unsupported-version`.
- One streaming pass then inflates only the chosen conversation entries, in archive order, yielding to the event loop between 64 KiB chunks of archive bytes. Inflation is synchronous (`UnzipInflate`), so one chunk's output is produced before the pass yields; an entry that declares a small size but inflates past `maxEntryBytes` keeps inflating until it ends, and the limit then stops the bytes being kept, not the work. The central directory supplies each entry's declared sizes before inflation: an entry over `maxEntryBytes` is rejected without being inflated, and a stored entry whose declared size differs from the bytes it holds is rejected as damaged. An accepted entry is accumulated and delivered whole; more bytes than it declares or than `maxEntryBytes` rejects it.
- The images of every chosen conversation are stored by a separate streaming pass before any conversation is parsed. That pass inflates only `chat_sessions/{id}_files/…` entries whose id the index selected, one at a time, and records the stored reference or the failure reason for each. Because it runs first, archive entry order does not matter and the conversation pass never reads an image by name.
- A by-name read serves the manifest, the index, and a replacement conversation. Each call re-parses the whole central directory, so a replacement costs one directory scan for its conversation file; its images are collected by one further image pass, not one read per image. The read returns at most the bytes the entry declares, truncating an entry that inflates to more; the pass reports that same condition as a size failure.
- Conversations are the `*.json` entries directly under `chat_sessions/` (not the `*_files/` subdirectories). An entry whose id the index does not select is skipped without being inflated. A chosen conversation is parsed and converted as it arrives; a conversation that is oversized, damaged, not JSON, or fails zod validation or conversion goes into `skipped`.

### Selecting the conversations

1. `chat_session_index.json` ranks the conversations the export carries: descending `updated_at`, then descending `inserted_at`, then ascending id. The import writes the newest `total = min(maxSessions, index rows)` of them, in archive order.
2. Session persistence and Workspace membership order by Session time rather than by write order, so the archive order the pass writes in does not change the Session list.
3. A conversation the archive does not carry, or one that fails conversion or storage, is reported in `skipped`; the next older conversation the index lists takes its place, fetched by name. `omittedByLimit` counts the conversations the index lists that no attempt reached.
4. `sessionIds` lists the imported Sessions newest first by the index order, whatever order they were written in.

### Linearizing the message tree (`selectBranch`)

- The selected message is the one named by `current_message_id`. The chain is traced from it along `parent_id` to the root with `parent_id === null`, then reversed. Other branches are dropped; each conversation yields one Session.
- When `current_message_id` is absent, null, or names no message, the message with the largest `id` is selected instead. Ids increase within a conversation and a child's id is always greater than its parent's, so that fallback is always a leaf.
- An empty `messages` list, duplicate message ids, a `parent_id` naming a missing message, or a cycle makes the conversation invalid and puts it into `skipped`.

### Message chain to Session events (`convertConversation`)

Messages on the chain are grouped as one turn per USER message: a USER message and the ASSISTANT message right after it form a turn. An ASSISTANT message without a preceding USER message (only possible in malformed data) is dropped. A USER message whose reply has status `CONTENT_FILTER` is dropped together with that reply: neither node produces an event, nothing is displayed, and later turns are numbered without a gap. A chain ending with USER yields a last turn with only the question. User and assistant need not alternate strictly: an excluded reply produces no `assistant/message`, so the next question follows the previous one directly, matching the history of a DSH turn that received several steered messages. A conversation without any remaining turn fails conversion and goes into `skipped`.

Events of one turn:

| Order | Event | Notes |
|---|---|---|
| 1 | `turn/start {turn: n}` | Time of the USER message |
| 2 | `step/start {turn: n, step: 1}` | In the first turn, followed by an empty `system/message` (`surfaceOp: 'append'`) as surface node 0 |
| 3 | `user/message` (`surfaceOp: 'append'`) | `source: { kind: 'user' }`, content below |
| 4 | Per step: `assistant/message` (`stream: []`), one `tool/call` / `tool/result` pair per tool call, `step/end`; the next step starts with `step/start` | Only for normally finished replies |
| 5 | `step/end` (last step) | |
| 6 | `turn/end` | `{ kind: 'completed' }` for a normal reply; `{ kind: 'error', error: { code, message } }` for an excluded or missing reply |

The empty system head derives no model message and renders no prompt card. The stored format accepts a `system/message` only as surface node 0 or after such a head, and every read of a stored log checks this; with the head in place, a resumed Agent replaces it with the real system prompt instead of appending a system message after the imported history.

A user message whose text is empty or whitespace and that has no attachment carries one text block with the empty string: the Turn and its row exist, and DeepSeek request serialization skips the empty user message, so that Turn's question is absent from the model context and a first Turn without text starts the request with its assistant message.

After the first turn, the conversation title appends `session/title { title, messageSeqs: [], source: { kind: 'user' } }`. The title is normalized with session-title's `normalizeSessionTitle`: whitespace collapses to single spaces and the text is truncated to `maxTitleBytes` UTF-8 bytes. A missing title, or one that normalizes to empty, writes no title event. The `user` source pins the title, so no title generation runs after import.

The assistant message `source` is `{ kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' }` without `replayState`. The DeepSeek adapter sends such foreign reasoning as unsigned thinking, the existing cross-model history path. No `usage`, `request/header`, `request/context`, or `model/selection` is written: the first request after resume records an `initial` header with the deployment's default model and shows no model-switch notice.

`stream` is an empty array. The export has no per-token stream record, and a fabricated stream cannot satisfy the check that the stream reconstructs the content exactly; the empty array passes the existing checks, and the Web assistant row renders from `message.content`.

**Event times.** Each event's `time` is the `inserted_at` milliseconds of its export message, clamped to be non-decreasing in order of appearance (which absorbs the assistant reply that is a few milliseconds earlier than its question). Within one reply, each THINK with `elapsed_secs` advances the time cursor by that many milliseconds, and later steps use the advanced time, so step intervals reflect the original reasoning duration. The Session header's `createdAt` is the time of the first event.

### Fragment mapping

| Fragment | Message | Mapping | Enters model context |
|---|---|---|---|
| `REQUEST` | USER | Text of `user/message` | Yes |
| `FILE` (image) | USER | `{ type: 'image', attachment }` when the `export_path` entry exists and the attachment service stored it; otherwise a synthetic file card, `{ type: 'file', attachment }` with a reference naming no stored object | The stored image on image-capable routes; otherwise the file handle text, whose named path holds no bytes |
| `FILE` (not an image) | USER | Synthetic file card: `{ type: 'file', attachment }` whose reference is `attachmentId = sha256('deepseek-chat-export:' + file.id)`, `name = file_name`, `bytes = file_size` (0 when absent); the file body is not in the export, so no object exists for it and the handle's path holds nothing | Yes, as file handle text |
| `THINK` | ASSISTANT | `{ type: 'reasoning', text }` in the current step; empty text is ignored | Yes (per adapter rules) |
| `RESPONSE` | ASSISTANT | `{ type: 'text', text }` in the current step; empty text is ignored | Yes |
| `TOOL_SEARCH` | ASSISTANT | `web_search` call with arguments `{"queries": [...]}`; the result body comes from `formatSearchOutput` of `dsh-tool-web`; `meta` is `{ sources: [{ url, title, snippet, publishedAt }], truncated: false }`, rendered as the standard search card. `WIP` is skipped as incomplete; `FAILED` yields `isError: true` with the fixed text `Error: the export records this search as failed.`; a missing `status` behaves as `FINISHED`. Ignored when every query is empty or blank | Yes |
| `TOOL_OPEN` (with url) | ASSISTANT | `web_fetch` call with arguments `{"url": ...}`; the result body holds the title, URL, and a note that the page body is not in the export; with `status: FINISHED`, `meta` is `{ url, statusCode: 200, truncated: false }`, rendered as the standard fetch card; `FAILED` yields `isError: true`; `WIP` is ignored | Yes |
| `TOOL_OPEN` (url null or empty) | ASSISTANT | Nothing: the exporter writes one all-null record with `stage_id` and `group_id` beside the real opens of a stage, which names no page | No |
| `TOOL_FIND` | ASSISTANT | Nothing: the website shows the find as its own row, which has no counterpart message block | No |
| `TOOL_IMAGE_SEARCH` | ASSISTANT | Nothing: the website shows no row for an image search, and the reply's reasoning already states what the model took from its results; the searched image is not in the export | No |
| `READ_LINK` | ASSISTANT | One Markdown link line per result: `[title](url)`, the URL as its own text when the title is missing, the title alone when the URL is missing, and nothing for a result with neither; the body stays a signature that cannot be decrypted without the key | Yes (text) |
| `TIP` | ASSISTANT | Nothing: a website notice rather than model output, shown by the website as a banner | No |
| `CONTENT_RISK` | ASSISTANT | Ignored: a fixed disclaimer with no information | No |
| `PARTIAL_FILE_READ` | ASSISTANT | Nothing: the website shows the partial read as its own row | No |
| `TEMPLATE_RESPONSE` | ASSISTANT | Excludes the whole reply; `turn/end` carries the template text as the error message | No |
| Unknown type | Any | Ignored | No |

**Step boundaries.** A fragment that carries a `stage_id` shares the open step while the value stays the same. A different value starts a new step only when the open step already holds a tool call; otherwise the open step adopts the new stage. A call-less step that is not the last would put two assistant messages in a row in the resumed history, which the live loop never produces, so a text-only step stays merged with the next call. A step opened by a fragment without a stage adopts the next stage it sees. Fragments without `stage_id` keep the older rule: THINK or RESPONSE after a tool call ends the current step and starts the next, and the records that do not carry a stage behave as text there. A `WIP` record is skipped and does not split a step. Consecutive tool fragments with one `stage_id` fall into one step, like one parallel call. Ignored fragments do not split steps, so "THINK, three TOOL_OPEN with null url, THINK" keeps one step holding both reasoning blocks.

For the website's search-while-thinking replies, `THINK, TOOL_SEARCH (stage 1), THINK, TOOL_OPEN×4 (stage 2), THINK, RESPONSE` maps to three steps: (1) reasoning + `web_search`; (2) reasoning + four `web_fetch`; (3) reasoning + answer. A directly consecutive `TOOL_SEARCH (stage 1)` then `TOOL_OPEN (stage 2)` without reasoning between them splits into two steps because the first step already holds the search call.

**Block order within a step.** One step's `assistant/message` carries its text blocks (reasoning, answers, link lines) before its tool-call blocks, each group in the order recorded. Text that the export records after a tool call in the same step is therefore stored before that call, while the step sequence and every cross-step order stay as exported. Interleaving text after a tool call inside one assistant message would not match any step the live loop produces.

**Ids.** Message ids and tool-call ids come from the caller-injected `createId()` (`randomUUID` in production); the `tool-call` block id, `tool/call.callId`, and the `source.callId` and `toolCallId` of the `tool/result` message are the same.

### Reply status mapping

The export documentation requires that messages other than `FINISHED` and template replies stay out of the model context. A reply withdrawn by content filtering (`CONTENT_FILTER`, shown as withdrawn on the website) is dropped with its question, as described above. Every other excluded reply writes no `assistant/message` and no `assistant/attempt` (the Web does not show attempts, and "user message + attempt + retryable error code" would make the GUI offer to continue generating). The user sees the turn's closing error row with its reason and code:

| Original reply | `turn/end.reason.error.code` | `message` (English, written to the log) |
|---|---|---|
| `FAILED` / `TIMEOUT` / `CONTEXT_LENGTH_EXCEEDED` / `INCOMPLETE` / `WIP` | `DEEPSEEK_EXPORT_FAILED` / `DEEPSEEK_EXPORT_TIMEOUT` / `DEEPSEEK_EXPORT_CONTEXT_LENGTH_EXCEEDED` / `DEEPSEEK_EXPORT_INCOMPLETE` / `DEEPSEEK_EXPORT_WIP` | The original reply ended with status "{STATUS}" and is excluded from the model context. |
| Any other status | `DEEPSEEK_EXPORT_UNFINISHED_REPLY` | The same message with the status quoted |
| Contains `TEMPLATE_RESPONSE` | `DEEPSEEK_EXPORT_TEMPLATE_RESPONSE` | The template text itself |
| `FINISHED` without importable content | `DEEPSEEK_EXPORT_EMPTY_REPLY` | The original reply has no importable content. |
| Chain ends with USER (no reply) | `DEEPSEEK_EXPORT_NO_REPLY` | The export contains no reply to this message. |

Error codes are fixed strings; text from the export appears only inside the message. These codes are outside the session-controller's continuable code set, so no "continue generating" appears. The question itself stays in context.

### Session writes

The import creates no live Agent and writes the persistence layer directly. Failures detected before the pass (an unreadable archive, a missing, oversized, or unsupported manifest or index, no importable conversation, an oversized upload) write nothing; an archive whose structure breaks during the pass fails as `unreadable-archive` after the Sessions delivered before the break were written. Each conversation is fully converted and seed-validated with `Session.create` before it is written; a conversation that fails is skipped and does not stop the others. Each chosen conversation is converted and written as its archive entry arrives, and a conversation a failure pulls in afterwards is read by name. For each conversation:

1. The import checks that the target Workspace is still registered and that its directory exists; otherwise it stops with `workspace-not-found`, and the Sessions written before remain.
2. The conversation is converted with the image references the image pass already stored. An image whose conversation later fails conversion or seed validation is already stored and keeps no referencing event.
3. `Session.create(id, seed, header)` runs the same seed validation as a live append (JSON serializable, consecutive seq, valid surface transitions, valid message fields); the detached validation instance is discarded.
4. `ctx.sessionPersistence.create(header)` → `handle.append(events)` → `handle.flush()` → `handle.close()` (closed on failure too). The header is `{ version: SESSION_FORMAT_VERSION, id, createdAt, cwd, isSeeded: false }`, and `cwd` is the Workspace's canonical path. The stored events have no `session/end-seed`; the ordinary resume path appends that marker on first open.
5. When the projection cache is available, `coldSnapshot(header, SessionLogOffset(0), events)` refreshes the cached row the sidebar reads (title, last question time, non-blank).
6. `workspace.attachSession(id)`. When it fails, the conversation goes into `skipped` with the reason "stored as Session {id} but not added to the workspace"; `SessionPersistence` offers no removal, so that Session stays stored outside the Workspace.

The converted events are released before the next conversation, and the import yields to the event loop between conversations and checks cancellation at each step. A written Session appears in `session/list` like any other cold Session and opens through the ordinary resume path. The import adds no Session event type, does not change `SESSION_FORMAT_VERSION`, and needs no persistence-type acknowledgement.

### Client

- ui-sidebar declares the HOC slot `sidebar.session.action` (`scope: 'root'`, owner `{ wide: boolean }`) around the New-session row content, so an occupant receives that content as `children` and returns it, possibly wrapped, plus its own controls. The trigger renders right of "New session" (on the same row in the wide sidebar, where "New session" takes the remaining width; stacked below the "New session" icon in the narrow sidebar).
- The plugin's Client face `$mount`s its own `/remote` contribution (the self-mounting form of `dsh-api-remote-access`, outside the `dsh-api-remotes` aggregate) and registers `ImportSessionsAction` as the `sidebar.session.action` layer. It renders the row content first, then its trigger, then the dialog; a Peer that may not import gets the row content unchanged, so the New-session button keeps rendering. The button shows only when `useRemoteAccess('deepseekChatImport/limits')` is true; the dialog is local state of the layer rendered through the `Modal` portal.
- The upload uses `XMLHttpRequest` on a served page because Fetch exposes no upload progress. A page whose Host runs in another execution context (the static Cloudflare Pages preview) supplies `__DSH_TRANSPORT__.fetch`: the archive goes through that carrier with no byte progress, straight to the reading and importing phases. The URL is `UPLOAD_ROUTE` resolved against `document.baseURI`, so a path-prefixing proxy keeps working. A non-200 answer, an answer without an outcome line, a line that is not a valid protocol value, or a connection failure becomes the `upload-failed` outcome; a thrown error is shown with the unknown-failure copy.
- The carrier selection does not reuse `@deepseek-ai/dsh-client-file-upload`. That package's service buffers the whole response, which would lose the streamed NDJSON progress, and its `post` method is not part of its public surface; keeping the selection here preserves both the progress lines and the package edge.
- Copy goes through locale dictionaries in eight languages, with sentence case in English; summary lines have `.one` / `.other` forms chosen by `count === 1`.

### Realization

`sidebar.session.action` is an HOC layer rather than a list because the occupant decorates the row's content instead of rendering beside it: it receives that content as `children`, returns it, possibly wrapped, and adds its own controls without introducing a wrapper element. A list entry would render as a sibling of the row content, and the rail-in fade targets the slot outlet's children because the `display: contents` outlet anchor cannot carry an animation itself.

The obligation is contract-only. An occupant that adds nothing, or may not act, must return `children` unchanged, because the renderer only rescues a layer that throws. A layer may legitimately omit `children`, which removes the New-session button, so no runtime check replaces the obligation.

### Images

- The image pass walks every image entry of a chosen conversation in archive order, without parsing the conversation. It inflates only `chat_sessions/{id}_files/…` entries whose id the index selected, calls `ctx.attachments.saveImage({ data, mediaType, name })` with the entry's extension and file name, and records the reference or the failure reason under the entry name. An extension other than png / jpg / jpeg / webp / gif is recorded as unsupported without inflating the entry.
- `convertConversation` emits an `image` block (before the text) for each `FILE` entry whose `export_path` the pass stored and a synthetic file card otherwise.
- A missing, unsupported, oversized, damaged, or rejected image becomes a synthetic file card with one Host warning; the conversation still imports. A missing entry reports `not in the export`; a size, corruption, unsupported-type, or storage failure reports its own reason. Attachment storage deduplicates by content.
- The pass stores every image entry of a chosen conversation before the branch is selected and before conversion. An image of a withdrawn round, of a dropped branch, or of a conversation whose conversion or `Session.create` seed validation later fails therefore stays stored without a referencing event. Neither `SessionPersistence` nor the attachment store offers a removal.

### Testing

| Layer | File | Coverage |
|---|---|---|
| Conversion | `tests/conversation.host.spec.ts` | `current_message_id` selection with the largest-id fallback; linearization by id; REQUEST / THINK / RESPONSE; `stage_id` step boundaries and search/open-page step boundaries; failed, unfinished, and status-less searches; dropped image searches, address-less opens, page finds, partial reads, and tips; Markdown link lines; turn errors and fixed codes for excluded replies; dropped content-filtered rounds; an empty text block in the first and later turns; title normalization; synthetic file cards; invalid trees. Output passes `Session.create`, and `deriveMessages` asserts the model history |
| Archive | `tests/archive.host.spec.ts` | Entry listing, one-entry reads truncating to the declared size, the streaming pass, the declared-size limit with a highly compressible entry, misdeclared sizes, duplicate entry names, stored-entry size mismatches, damaged entries, cancellation |
| Orchestration | `tests/importer.host.spec.ts` | Latest K oldest first with progress; a synthetic 2026-11-12 archive carrying every new field; oversized, damaged, and invalid conversation files; filling the limit after failures; a replacement chain that survives an invalid candidate; attach failures; Workspace removal; archive-level failures; cancellation; images stored by the image pass in any archive order, the synthetic file cards of unstored ones, and the absence of by-name image reads on the main path |
| Route | `tests/upload.host.spec.ts` | Request validation; `too-large`; buffer sizing from the declared length; one import at a time; NDJSON lines; cancellation by the answer, the request, and unloading |
| Resume | `tests/resume.host.spec.ts` | The production agent loop continues an imported Session; the model request holds the imported history without the withdrawn round |
| Composition | `tests/composition.host.spec.ts` | Host booted through the Loader; owner-only `limits()`; an upload stores the Session in the Workspace; unloading during a paused import cancels it and completes only after it stops, with nothing written |
| Client | `tests/import-sessions.client.spec.tsx`, `tests/mount.client.spec.ts`, `tests/upload.client.spec.ts` | Button visibility, Workspace preselection, progress bar and texts, plural summaries, failure and thrown-error copy, refresh after every attempt, NDJSON line reading and validation |
| Bundle | `scripts/optional-bundles.spec.ts` | The bundle composes over the Web profile and resolves its title, description, and icon |
| Snapshot | `apps/web/tests/deepseek-chat-import.e2e.ts`, `snapshots/web/deepseek-chat-import/` | A synthetic 2026-11-12 export with a branch, reasoning, a search and fetch pair, a read-link record, a content-filtered round, and an incomplete reply is uploaded through the route; one imported Session continues with one recorded model turn, and the persisted log replays keyless |

## Alternatives considered

**Type a host path to the export.** The first design read a ZIP or an extracted directory from an absolute Host path and created a `<export>_workspace` directory next to it. Users must not type Host paths, a browser does not know them, and a remote Host has no access to the user's local download; the browser upload works the same for local and remote Hosts.

**List export files inside a chosen Workspace.** The user would place the ZIP in a Workspace directory and pick it from a Host-side listing. The user rejected this in favor of uploading the file directly from the browser.

**Stage uploads on disk.** Writing the upload to a temporary file would lift the memory bound but adds cleanup, crash residue, and a second copy of private data on the Host. The archive stays in memory, bounded by `maxUploadBytes`, and the service runs one import at a time.

**Decompress and validate all conversations before writing any.** This made "a rejected export writes nothing" true for conversion failures, but held every conversation file and converted log in memory at once and blocked the event loop for the whole import. Two streaming passes follow `chat_session_index.json`: one stores the images of the chosen conversations without decompressing any conversation, and one converts and writes each chosen conversation as it arrives.

**Report progress through a separate streaming Remote.** The route answer already streams through the Web server, so NDJSON lines on the same request need no second channel, keep progress and outcome ordered, and end with the request.

**Import the newest leaf only.** It is always a leaf and needs no extra field, but it silently imports a different branch than the one the user was viewing whenever the export was taken after switching back. `current_message_id` is the export's own linearization key, and the largest-id fallback keeps archives without it importable.

**Select by the selected message's `inserted_at`.** It is the time of the last imported event, but it needs every conversation's messages, so selection would decompress the whole archive before writing anything. `chat_session_index.json` carries the website's own update order and lets selection skip the conversations it does not choose; the cost is that the order follows renames and pins rather than the last imported event.

**Create live Agents through `ctx.agents.create({ seed })`.** It is the existing supported entry, but `createdAt` can only be the current time, so every imported Session would crowd the top of the sidebar, and importing thousands of conversations would create thousands of live Agents. Writing persistence directly keeps the original times and uses no runtime resources.

**One Session per branch, or branches inside DSH.** A DSH Session is a linear log; a Session per branch turns one website conversation into several hard-to-tell-apart Sessions. The requirement is the newest chain only.

**Keep the question of a content-filtered reply with an error row.** The website shows such rounds as withdrawn, and the user decided that neither node is imported; the remaining turns read as the user saw them.

**Write non-FINISHED or template replies as `assistant/attempt` or as `interrupted` `assistant/message`.** Attempts are invisible in the Web and, with retryable error codes, trigger "continue generating"; the content of an `interrupted` message enters the model context, which the export documentation forbids.

**Hard-code the import button in ui-sidebar.** The sidebar shell would depend on the import plugin's Remote namespace and carry a business branch; the slot costs one declaration and a small layout change.

**Add Session event types for TIP / CONTENT_RISK or the import origin.** That extends `SessionEventMap`, the persistence catalog, and the Web renderers beyond a small import; the notices do not change the answers.

**Mount the importer in the default Web composition.** The capability is experimental, and release packages must not depend on experimental packages. The optional bundle keeps the default product unchanged and offers the import to users who enable it.

## Consequences

The import brings website history into DSH with original titles, times, reasoning, and search cards, and the imported Sessions continue through the ordinary resume path. Host memory is bounded by the archive (`maxUploadBytes`) plus one entry (`maxEntryBytes`), one converted conversation, and the references of the stored images, and the event loop stays responsive between conversations. The price is that only conversations already written survive a cancellation or a mid-import failure, and a conversation a failure pulls in is read by name and gets one further image pass.

- **Cold writes are a production writer outside the agent loop.** The import uses fresh Session ids and closes each handle after writing, so it does not compete for ownership with live Sessions; if the persistence layer later assumes that every write goes through the agent loop (for example by registering derived state at creation), the import path must change with it.
- **A Session stored but not attached stays stored.** `SessionPersistence` offers no removal; the import reports such a Session in `skipped` with its id.
- **Historical tool calls have no tool records.** The imported `web_search` / `web_fetch` calls have no matching `request/header.tools` record. If a deployment does not register these tools, or a provider rejects history that references undeclared tools, the first request after resume fails; text-only mapping is the fallback.
- **The fetch card's status code is inferred.** The export records only that the page opened, not an HTTP status; `statusCode: 200` makes the card show a successful fetch.
- **Foreign reasoning is sent to the model again.** Imported reasoning is sent as unsigned thinking, which raises the input tokens of the first request after resume; the KV cache starts with that request.
- **Re-import duplicates.** Importing the same export again writes new Sessions; the import does not record which conversations it already imported.
- **The viewed branch decides the import.** `current_message_id` selects the chain, so an export taken after the user switched back to an older branch imports that branch; only an absent or unknown id falls back to the newest leaf.
- **One export structure.** The importer targets the 2026-11-12 structure. Older v3 archives still import because the added fields are optional, but their `READ_LINK` no URL or title, so its link lines carry less (an older `TOOL_FIND` pattern is no longer read at all).
- **`maxTitleBytes` is a separate setting.** The session-title service does not expose its limit, so a composition that changes session-title's `maxTitleBytes` sets the importer's field to the same value.
- **Content given up.** Other branches, content-filtered rounds, `CONTENT_RISK` disclaimers, `TIP`, `TOOL_FIND`, and `PARTIAL_FILE_READ` records, encrypted `READ_LINK` bodies, search-result `snippet` and `site_name`, the `pinned` flag, non-image file bodies, per-token reasoning times, and `accumulated_token_usage` are not imported; token accounting after import uses estimates. The explanations of excluded replies and of a failed search are fixed English text.
