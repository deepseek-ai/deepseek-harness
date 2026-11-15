---
description: "Import DeepSeek website chat exports: upload a deepseek_data ZIP from the browser and store its recent conversations as Sessions in a chosen Workspace."
kind: "package-bundle"
---

# @deepseek-ai/dsh-deepseek-chat-import

English | [中文](README.zh.md)

## Summary

Bring the chats exported from the DeepSeek website (chat.deepseek.com) into DSH and continue them. After you enable this optional bundle, a button right of "New session" uploads the `deepseek_data-*.zip` file to the Host, which stores the most recent conversations as Sessions in the Workspace you choose. Imported Sessions keep their original titles and times and show the original questions with their attached files, reasoning, web search cards, read links, and answers. The [Agent Note](../../../.agents/notes/implemented/feature/2026-11-11-deepseek-chat-export-import.md) records the design and its trade-offs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

In the GUI, open the Plugins page, click "More" to open "Experimental plugins", and switch on "DeepSeek chat import". The installation ships the bundle switched off; the [plugin manager page](../../client/ui-plugin-manager/README.md#use-this-package) owns how More bundles are listed and enabled. Switching it off removes the button and the upload route; imported Sessions stay.

The bundle inserts one Host row, which an explicit composition can also mount:

```yaml
- id: deepseek-chat-import
  name: '@deepseek-ai/dsh-deepseek-chat-import'
```

The Host half injects `typert`, `connection`, `sessionPersistence`, and `workspaceRegistry`, and reads `sessionProjectionCache` and `attachments` when they are mounted. The browser half injects `remote`, `slots`, `locale`, and `sessions`, and wraps the ui-sidebar New Session row through its `sidebar.session.action` HOC slot: it returns the row content followed by its own button, or the content alone for a Peer that may not import. Only the owner imports: the upload route admits only owner Peers, `limits()` refuses every other principal, and the button shows only for a Peer that may call `deepseekChatImport/limits`.

### Import a chat export

1. On the DeepSeek website, export all chats and download the `deepseek_data-*.zip` file.
2. Click the upload-arrow button right of "New session".
3. Under "Export file", choose the ZIP file. Under "Workspace", keep the preselected Workspace of the current Session, pick another one, or choose "Add workspace…" to add a directory.
4. Click "Import". On a served page the progress bar shows the upload percentage; a page that carries the archive over its own transport has no byte progress, so the bar starts with the Host reading the archive. Both then show "Importing n/K" while Sessions are written; closing the dialog cancels the request.
5. The dialog reports how many Sessions it imported into which Workspace, how many older conversations exceeded the limit, and how many conversations it could not import. However the attempt ends, the Session list refreshes, so Sessions written before a failure or cancellation appear.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxSessions` | `1000` | Most Sessions one import writes, choosing the conversations the export index lists as most recently updated. |
| `maxUploadBytes` | `536870912` (512 MiB) | Largest export archive one upload may carry; the whole archive is held in memory while it is imported. |
| `maxEntryBytes` | `268435456` (256 MiB) | Largest declared uncompressed size of one archive entry; a larger entry is never decompressed. |
| `maxTitleBytes` | `80` | Largest UTF-8 size of an imported title; keep it equal to the session-title `maxTitleBytes` of the composition. |

### Import results

- Each website conversation becomes one Session. The imported chain ends at the message named by `current_message_id`; when that field is absent, null, or names no message, it ends at the message with the largest id. Other branches are dropped.
- `chat_session_index.json` selects the conversations: the newest `maxSessions` by its `updated_at` (ties by `inserted_at`, then id) are imported in archive order, one at a time. When one of them fails, the next older conversation the index lists takes its place.
- Titles keep the original title with whitespace collapsed and truncated to `maxTitleBytes`, pinned as a user title, so no title generation runs. A title that is empty after normalization writes no title. Event times follow the export and never decrease; the `elapsed_secs` of reasoning advances the time of the following steps.
- A user message without text, a stored image, or a file keeps one empty text block: the row renders, and DeepSeek request serialization drops it like any other empty user message, so that turn's question is absent from the model context (a first turn without text therefore starts the request with the assistant message).
- Images in user messages become image attachments when the export contains the file (png, jpg, jpeg, webp, or gif) and the attachment service stores it. Other images and every non-image file become a synthetic file card that shows a file-type icon, the name, and the exported size; the card cannot be opened, holds no bytes, and reaches the model as a file handle whose named path holds no bytes. The Host log records why each image was not stored.
- Web searches become `web_search` calls and opened pages become `web_fetch` calls, shown as the standard search and fetch cards. A search the export records as failed becomes an error result. A search still in progress, an opened page without an address, and an image search are left out, as the website leaves them out of the reply.
- A `READ_LINK` record becomes one Markdown link line per linked page, `[title](url)`, with the URL as its own text when the title is missing and the title alone when the URL is missing. A `PARTIAL_FILE_READ`, `TOOL_FIND`, `TIP`, or `CONTENT_RISK` record is left out, as the website shows none of them as reply text.
- A question whose reply was withdrawn by content filtering (`CONTENT_FILTER`) is left out together with the reply: neither appears, and the model never sees them. A conversation with no other turn is not imported.
- Other replies whose status is not `FINISHED`, template replies, and replies without importable content stay out of the model context; their turn ends with an error row that shows the reason and a fixed `DEEPSEEK_EXPORT_*` code. The question stays.
- Importing the same export again writes another set of Sessions.

### Failures

Failures detected before the streaming pass write nothing. Each conversation is fully converted and seed-validated with `Session.create` before it is written; a conversation that fails is skipped and does not stop the others. An archive whose structure breaks during the pass fails as `unreadable-archive` after the Sessions delivered before the break were written, and the response does not list them. The dialog shows the localized explanation of each reason; a `too-large` failure reported by the Host instead shows the Host's own message, which names the limit it applied.

| Reason | When |
|---|---|
| `too-large` | The file exceeds `maxUploadBytes`, or an entry declares or stores more than `maxEntryBytes` (including `manifest.json` and `chat_session_index.json`); the browser checks the file size first, the Host stops reading at `maxUploadBytes`, and an entry over `maxEntryBytes` is never decompressed. |
| `unreadable-archive` | The file is not a readable ZIP archive, `manifest.json` is damaged, a stored entry declares a size other than the bytes it holds, or two central-directory entries share a name. |
| `missing-manifest` | The archive has no `manifest.json`. |
| `missing-index` | The archive has no readable `chat_session_index.json`. |
| `unsupported-version` | `manifest.json` does not declare `export_format_version` 3. |
| `no-conversations` | `chat_session_index.json` lists no conversation. |
| `workspace-not-found` | The chosen Workspace no longer exists. During an import, the import stops and keeps the Sessions already written. |
| `busy` | Another import is running on this Host. |

A conversation file that is oversized, damaged, cannot be parsed or converted, or whose Session cannot be stored, is skipped and counted in the result; the Host log names the defect. An image the archive cannot deliver becomes a file card and is named in the Host log. Cancelling keeps the Sessions already written.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Modules

| File | Responsibility |
|---|---|
| [`src/protocol.ts`](src/protocol.ts) | The upload path `/api/deepseek-chat-import/archive` and its document-relative form |
| [`src/upload.ts`](src/upload.ts) | `createUploadRoute()`: request validation, bounded in-memory buffering, the streamed NDJSON answer, and cancellation |
| [`src/archive.ts`](src/archive.ts) | `openExportArchive()`: the ZIP central directory, streaming passes that inflate only the entries they are asked for within `maxEntryBytes`, and a by-name read |
| [`src/format.ts`](src/format.ts) | zod validation of `manifest.json`, conversation files, and the fragment types this package maps |
| [`src/conversation.ts`](src/conversation.ts) | Pure `selectBranch()` and `convertConversation()`: message tree to seed events |
| [`src/importer.ts`](src/importer.ts) | `importDeepseekChatExport()`: index selection, the image pass, the conversation pass, writes, and Workspace attachment |
| [`src/index.ts`](src/index.ts) | `DeepseekChatImportService`, its `Config`, the single import slot, the route registration, and `@Remote limits()` |
| [`src/client/`](src/client/index.ts) | Button, dialog, browser upload over the page carrier or XHR, and locale dictionaries |
| [`cordis.patch.yml`](cordis.patch.yml) | The optional bundle row |

### Upload

The browser calls `limits()` and rejects a file over `maxUploadBytes` before sending it. A served page posts the file with `XMLHttpRequest` (for upload progress) to `api/deepseek-chat-import/archive?workspaceId=…`, resolved against the document base. A page whose Host runs in another execution context, such as the static Cloudflare Pages preview, supplies `__DSH_TRANSPORT__.fetch` instead: the archive goes through that carrier, which reports no byte progress, so the dialog moves straight to the reading and importing phases. The Host registers this path as an exact route on `ctx.connection.fetch`, which only owner Peers reach. The route requires `application/octet-stream`, takes the service's single import slot, resolves the Workspace, and reads the streaming body into one buffer sized from `content-length` until it ends or exceeds the limit. The upload is never written to disk. The answer is `application/x-ndjson`: `{ type: 'progress', done, total }` lines while Sessions are written, then one `{ type: 'outcome', outcome }` line whose `outcome` is `{ ok: true, value }` or `{ ok: false, error: { reason, message } }`; the browser reads complete lines as they arrive and settles the answer as invalid at the first line that is not a valid protocol value, cancelling the rest of the stream so a later outcome cannot replace it. Closing the dialog, a dropped connection, or unloading the plugin aborts the import, and unloading completes only after the import stops writing.

### Event mapping

Each USER message opens a turn: `turn/start`, `step/start`, `user/message`. The first turn also writes an empty `system/message` before its `user/message` as the protected surface head, which a resumed Agent replaces with the real system prompt; it adds no model message and no visible row. A finished reply is split into steps in fragment order: THINK and RESPONSE append to the current step's `assistant/message`, and web search and opened pages append tool calls. Tool calls that carry a `stage_id` share one step while the value stays the same, and a different value starts a new step; a step opened by text adopts the stage of the first call that joins it, so a step that is not last always has a call. Reasoning or text after a tool call starts a new step. The turn ends with `turn/end { kind: 'completed' }`. An excluded reply writes no `assistant/message` and ends with `turn/end { kind: 'error' }`. Assistant messages carry the source `deepseek-chat-export` / `deepseek-chat-export`, an empty `stream`, and no `usage`, request header, or model selection. The [Agent Note](../../../.agents/notes/implemented/feature/2026-11-11-deepseek-chat-export-import.md) owns the complete fragment and status tables.

### Writes

The import creates no live Agent and holds one conversation at a time. The index selects the conversations; one streaming pass stores the images of every chosen conversation before any conversation is parsed, and a second converts and writes each chosen conversation as it arrives. The conversation pass looks the stored references up, so archive entry order does not matter and no image is read by name on the main path. An image that is missing, oversized, damaged, of an unsupported type, or rejected by the attachment service becomes a synthetic file card with one Host warning. Before writing, it checks that the Workspace is still registered and its directory exists. `Session.create()` then runs the same seed validation as a live Session; `sessionPersistence.create()` writes the header and events, and the handle is flushed and closed. `coldSnapshot()` on the projection cache refreshes the title and activity time the sidebar reads, and `attachSession()` adds the Session to the Workspace. The header's `createdAt` is the time of the first event, and `cwd` is the Workspace's canonical path. The stored log has no `session/end-seed`; the ordinary resume path appends it on first open. The import yields to the event loop between conversations. A cold write emits no `session/created`, so the browser calls `sessions.refresh()` after every attempt.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Design Agent Note](../../../.agents/notes/implemented/feature/2026-11-11-deepseek-chat-export-import.md) — format differences, mappings, alternatives, and consequences.
- [Session persistence](../../session/session-persistence/README.md) — the store the import writes.
- [Workspace registry](../../workspace/workspace/README.md) — Workspace membership.
- [Web tools](../../web/tool-web/README.md) — the search and fetch results and cards that imported calls reuse.

-----

<a id="model-experience"></a>
## Model Experience

### Imported history

#### What the model sees

The import sends no model request. When the user continues an imported Session, the model sees the imported questions, reasoning, `web_search` / `web_fetch` calls and results, answers, Markdown link lines of read-link records, and the file handles of synthetic cards, whose bytes do not exist; content-filtered rounds, excluded replies, template text, tips, page finds, partial-read notices, and `CONTENT_RISK` disclaimers are absent. A synthetic file card enters the context as the file handle that names the file and its size and points at a path that holds nothing; a question without any content sends no message. A fetch result holds only the page title, URL, and a note that the page body is not in the export.

#### Token effect

The first request after resume sends the whole imported history. Imported reasoning is sent as unsigned thinking and increases that request's input tokens; imported images are sent on image-capable routes and replaced by the general omission note elsewhere.

#### KV Cache effect

The first request after resume has no reusable cached prefix; later requests extend it like any other Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Archive held in memory** — the whole upload stays in Host memory during the import, bounded by `maxUploadBytes`, plus one converted conversation, one image entry at a time, and the references of the images stored so far; one Host runs one import at a time. Conversations and images the index does not select are never inflated.
- **Synchronous inflation** — the streaming pass inflates each selected entry synchronously with fflate's `UnzipInflate`. An entry that declares a small `originalSize` but carries highly compressed data keeps inflating until the entry ends, and `maxEntryBytes` only stops those bytes being kept. A crafted archive can occupy the Host for a long time before the entry is rejected.
- **Duplicate local file headers** — duplicate detection covers the central directory only. A second local file header renamed to an existing entry name is not detected, so an archive can deliver more conversations than the index lists, and the write count is not additionally guarded.
- **Partial writes on a corrupted archive** — an archive whose structure breaks after some entries were delivered fails as `unreadable-archive` after those Sessions were written, and the failure response does not list them.
- **`read()` truncates** — `ExportArchive.read` returns at most the size an entry declares, truncating one that inflates to more, while `stream` reports that condition as a size failure. The manifest, the index, and a replacement conversation are read by name, so one of them can arrive truncated. Each by-name read also re-parses the whole central directory: the manifest and the index pay it once each, and a replacement conversation pays once more.
- **No upload percentage on the carrier path** — a page that carries the archive through `__DSH_TRANSPORT__.fetch` reports no byte progress; the dialog shows only the reading and importing phases.
- **One export structure** — the importer targets the 2026-11-12 structure: `current_message_id`, `stage_id`, the tool statuses, the link and find fields, and the new record types. The fields that structure added are read as optional, so an older v3 archive still imports, but it is not a supported target.
- **ZIP upload only** — an extracted export directory or a Host path cannot be imported.
- **Re-import duplicates** — importing the same export again writes new Sessions; the import does not track which conversations it already imported.
- **Synthetic file cards** — images the export lacks, of an unsupported type, over `maxEntryBytes`, or rejected by the attachment service (for example over its size limit), and every non-image file, become cards without bytes: they show the name and the exported size, cannot be opened, and name no stored object, so a model that reads the named path finds nothing. Non-image file bodies are not in the export.
- **Images without a referencing event** — the image pass stores every image entry of a selected conversation before any conversation is parsed. Images of a withdrawn round, of a branch the import drops, and of a conversation whose conversion or `Session.create` seed validation later fails stay as attachments that no event references. Neither `SessionPersistence` nor the attachment store offers a removal, so those bytes remain.
- **Stored but not attached** — when adding a written Session to the Workspace fails, `SessionPersistence` offers no removal, so the Session stays stored outside the Workspace; the result lists it in `skipped` with its id.
- **Separate title limit** — the session-title service does not expose its `maxTitleBytes`, so a composition that changes it sets this package's `maxTitleBytes` to the same value.
- **Content not imported** — other branches, content-filtered rounds, `CONTENT_RISK` disclaimers, `TIP`, `TOOL_FIND`, and `PARTIAL_FILE_READ` records, encrypted `READ_LINK` bodies (only the exported URL and title are shown), search-result `snippet` and `site_name`, the `pinned` flag, per-token times, and `accumulated_token_usage`.
- **English diagnostics** — the explanations of excluded replies and of a failed search are fixed English text in the log and the tool result, and a `too-large` failure reported by the Host shows its English message in the dialog.
- **Inferred tool records** — imported `web_search` / `web_fetch` calls have no matching request-header tool record, and the fetch card's `statusCode: 200` is inferred from a successful open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/conversation.host.spec.ts` covers the mapping rules, `tests/archive.host.spec.ts` the archive view, `tests/upload.host.spec.ts` the route, `tests/importer.host.spec.ts` the orchestration with synthesized ZIPs, `tests/resume.host.spec.ts` continuing through the production agent loop, `tests/composition.host.spec.ts` the Loader composition, and `tests/*.client.spec.*` the button, dialog, upload, and mounting. The keyless Web snapshot `snapshots/web/deepseek-chat-import/` (driver `apps/web/tests/deepseek-chat-import.e2e.ts`) imports a synthetic export through the route and continues one imported Session with one recorded model turn. When the fragment mapping changes, update the Agent Note's mapping tables in the same change.

</details>
