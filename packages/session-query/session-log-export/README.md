---
description: "Web Session-log ZIP export and Markdown copy: Host streaming, authenticated routes, Session Header actions, and the /export command."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

English | [中文](README.zh.md)

## Summary

`dsh-session-log-export` lets the Web interface export a session's complete history. The Session Header's more-actions menu offers `Copy Session as Markdown` and `Download session log`; an `/export` slash command also starts the ZIP download. The ZIP contains the session, its sub-sessions, and attachments. The package owns both authenticated Host routes, the Markdown transcript formatter, and the browser controls and feedback. The browser chooses the download destination and owns the clipboard. Setup and usage come first; implementation details follow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when the Web bundle should let users export a session log. It requires Connection, the command registry, Session query and persistence, and attachments. Mount the plugin, then choose `Copy Session as Markdown` or `Download session log` from the Session Header's more-actions menu, or type `/export`; the browser copies the transcript or downloads `dsh-session-<id>.zip`.

### Copy Session as Markdown

`Copy Session as Markdown` copies the complete selected Session, including history that the client has not loaded, as portable Markdown. The transcript starts with the latest log-backed title. Human user messages are blockquotes in chronological order, final assistant replies remain ordinary Markdown, and earlier assistant commentary and tool activity in each turn are folded into a collapsible `<details>` section before that turn's final reply. A turn whose last committed assistant message carries tool calls has no final reply, so all of its activity stays folded. An incomplete turn renders the committed messages it has. Only append message events are exported. An unfinished assistant code fence is closed at the message boundary, and four-space or tab-indented code keeps its indentation.

The formatter reads the committed raw log, so a compaction surface replacement never removes earlier messages, and fork-inherited history appears once. The title and body come from one `readSession` snapshot. When persistence metadata reports a selected materialized artifact, the transcript adds a `Session file:` fenced text block with that exact path; without one, the block is absent. Only the selected Session and its inherited prefix are copied; descendant logs remain ZIP-only. Reasoning blocks, system and developer messages, injected user-role context whose source kind is not `user`, request headers and context, and runtime records are omitted. Images and files become readable labels; attachment bytes and authentication links never enter the transcript. Structural labels such as `Assistant`, `Tool`, and attachment placeholders are intentionally English; original message text stays unchanged. The text ends with exactly one newline.

The clipboard is one browser-wide destination, so this plugin instance runs one copy at a time. On hosts with `ClipboardItem` and `navigator.clipboard.write`, the write starts synchronously from the click with a promised `text/plain` Blob while the transcript is read; other hosts fall back to the shared clipboard helper after preparation. A request made while a copy is pending joins that operation and keeps the first click's Session. Every Session Header reflects copying in `aria-busy` and disables its copy row until the operation settles. Success, preparation-failure, or clipboard-failure feedback uses the root overlay toast. Disposal aborts the read and prevents later text from reaching the Blob; an operating-system clipboard write already accepted cannot be rolled back.

When `ui-message-feedback` is mounted, the same menu also offers `Feedback`, which opens its existing Session feedback dialog. Opening or dismissing that form does not export the Session or submit feedback. The feedback row follows the feedback plugin's availability; both export actions remain available independently.

### When to choose it

Choose it for a Web deployment that needs user-facing session export: a readable Markdown transcript for copying and a ZIP archive for downloading, or for a backend caller that already holds a complete committed logical event snapshot and needs the same Markdown conversion. Avoid it when a Host path write is needed: the browser operations keep their result in the browser, and the conversion utility performs no IO. The logs are serialized from persistence read handles, so any mounted backend is supported.

### Backend conversion

The package entry also exports `formatSessionMarkdown(events, sourcePath?)`: a pure backend utility for callers that already hold a complete committed logical event snapshot in seq order, including any inherited prefix. It reads the latest `session/title` event, returns Markdown ending in one newline, performs no IO, starts no plugin or Session, and does not mutate the events. An optional backend-resolved `sourcePath` is emitted verbatim in a dynamic fenced `Session file:` block after the title; omitted or empty paths add no block. Missing or blank titles produce `Untitled Session`. Only the supplied events are converted; descendant Session logs are not read.

```ts
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatSessionMarkdown } from '@deepseek-ai/dsh-session-log-export'

export function convertTranscript(events: readonly SessionEvent[], sourcePath?: string): string {
  return formatSessionMarkdown(events, sourcePath)
}
```

### Composition

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

The Web bundle mounts the package with Connection, `dsh-commands`, `dsh-client-ui-commands`, `dsh-client-ui-conversation`, and `dsh-client-ui-layout`. The layout package declares the `shell.overlay` seat used by copy feedback; the other client packages provide the Header seat, locale, and command surface.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `compressionLevel` | `6` | DEFLATE level from 0 through 9 for each ZIP entry. |

### Command contract

| Input | Result |
|---|---|
| `/export` | Records a human-command lifecycle; the submitting browser downloads the document-relative `api/session.export?sessionId=<id>&includeDescendants=true` (Host route `/api/session.export`) |
| `/export <path>` | An error; browser downloads choose their destination through the browser's ordinary download behavior |

### What to expect

The dialog reports three phases: preparing, download started, or failed. Closing the dialog does not cancel an in-flight download, and the dialog does not reopen when that operation later settles. One session admits one active download at a time; repeated gestures share that operation. The export includes the live session's newest events: the host endpoint flushes a live root session before reading, so a slash-triggered ZIP includes the `command/run` and `command/done` pair that started the download; cold persisted sessions need no flush. Each logical log uses the current generation's canonical filename inside the archive (`session.jsonl` for v0, otherwise `session.vN.jsonl`), including beneath each sub-session directory. Images use `media/<attachmentId>.<ext>`, and generic files use `files/<digest-prefix>/<digest>/<name>`. Generic-file bytes are read and compressed as bounded chunks, so exporting a large upload does not buffer it in full.

Attachment collection reads declared content fields of built-in Session events and completed assistant stream blocks, including flat V4 tool-role messages. Unknown event payloads and unrelated fields remain unchanged in the exported log but do not cause attachment reads.

### Failures

The dialog shows a preparation error when the preflight fails before ZIP streaming starts — for example an unreachable or misconfigured host endpoint. A descendant or attachment read failure after the browser accepts the GET is reported by the browser download manager, not by the dialog. A Markdown preparation failure reports a toast asking the user to retry the Session read; a clipboard write failure reports a separate toast asking the user to check clipboard permission. Neither reports success for a partial or missing transcript, and no pending toast is shown.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package wires the export control and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design split

The package has two halves. The Host half ([`src/index.ts`](src/index.ts)) registers the `/export` command and contributes the exact `GET`/`HEAD /api/session.export` and `/api/session.markdown` Fetch routes to Connection; [`src/archive.ts`](src/archive.ts) builds the bounded ZIP stream, and [`src/markdown.ts`](src/markdown.ts) renders the Markdown transcript. The browser half ([`src/client/index.ts`](src/client/index.ts)) provides the shared download and Markdown copy controllers and UI, and observes `command/executed` so only the submitting browser starts a download.

The Header’s More action uses the shared compact Button, with a 28px square target and the same radius and hover fill as the right-sidebar expand control.

### Download flow

Both entry paths issue a `HEAD` preflight to the document-relative `api/session.export?...`, then hand the GET route to the browser download manager without buffering the ZIP in JavaScript. One controller owns one in-flight download per session, collapses concurrent gestures into that operation, and cancels the preflight on plugin disposal. Modal state lives in a snapshot store keyed by session, so the button and the command share one dialog per session.

The Host route is a feature-owned exact Fetch contribution. Connection applies its Host/Origin and browser-session checks and bridges the streaming `Response`; this package owns query validation, live-session flushes, handle-based log reads and attachment reads, ZIP generation, and HTTP status semantics.

### Markdown copy flow

The Header asks the Markdown copy controller for the clicked Session. During the click, the controller requests the deferred `ClipboardItem` write while it loads the document-relative `api/session.markdown?sessionId=<id>` route; other hosts fall back to the shared clipboard helper after preparation. The Host route reads the complete live-preferred logical log through `ctx.sessionQuery.readSession` and passes those events to the pure formatter. It separately asks `ctx.get('sessionPersistence')?.stat` for the selected materialized artifact path and passes that optional path to the formatter; a metadata-read failure is a sanitized preparation failure. The read is a detached export observation: it creates no Agent, retains no Session, and writes no Session data. It answers 404 for an absent Session and a sanitized 500 for every other read failure.

The controller holds one pending operation and one `shell.overlay` toast entry. A second Header request joins the pending operation, so the clipboard and its notice always describe the first click's Session. Both the preparation promise and the admitted clipboard write are observed; every rejection is contained. Disposal aborts the read, prevents later text from reaching the promised Blob, suppresses notices, and awaits admitted clipboard work.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the Web control to the host endpoint and the surrounding command and session surfaces.

- [dsh-client-connection](../../client/connection/README.md) — the authenticated Fetch-route carrier used by the Host endpoint.
- [Commands subsystem reference](../../../docs/subsystems/commands.md) — the human-command registry the `/export` command registers on.
- [dsh-client-ui-commands](../../client/ui-commands/README.md) — the browser command surface that renders and acknowledges `/export`.
- [Session Query package map](../README.md) — the retrieval family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Human export and copy controls

#### What the model sees

Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history. The Markdown copy action is also human-only: it reads the committed log, writes the browser clipboard, and appends no Session event.

#### Token effect

Zero. The command creates no model turn, and neither export control changes a request.

#### KV Cache effect

None. The log-only command lifecycle, browser download, and clipboard write do not change the derived request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Browser download, not a Host-path writer** — the browser chooses the local destination; no Host path or native folder action is returned.
- **Preflight reports only pre-stream failures** — a descendant or attachment failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.
- **Markdown contains committed history only** — an unsettled live token chunk has no committed text, so it is absent from the copied transcript. Compaction and fork inheritance follow the raw log rather than the current model context.
- **Markdown copy is the selected Session only** — descendant Session logs are exported by the ZIP download, not by the Markdown copy.
- **Transcript text is buffered in memory** — the complete Markdown string and its Blob are held before the clipboard accepts them. Browser clipboard limits can reject a large export; this package does not add a byte cap or truncate the requested complete transcript.
- **Accepted clipboard writes cannot be rolled back** — disposal stops pending preparation and feedback, but an operating-system write that already succeeded remains on the clipboard.
- **The source path is observed metadata, not an atomic log claim** — `stat` identifies the selected materialized artifact at export time. Live committed events can be ahead of that file, and an unmaterialized Session has no source-path block.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

#### Future: export destinations beyond the browser

The download is deliberately browser-scoped; a Host-path or native folder export would need a new endpoint contract and a decision on where the ZIP lands.

</details>
