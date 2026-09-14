---
description: "Workspace file service for the web GUI: bounded file reads through the composed filesystem, plus directory listing and instrumented filesystem observation inside the Session workspace root."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-workspace-files

English | [中文](README.zh.md)

## Summary

Use this package to preview files readable through a Session's filesystem from the web client. It reads UTF-8 text by page, reads bounded byte windows or complete files, resolves related files from a base file's directory, and reports file metadata. File reads may target paths outside the workspace; directory listing and instrumented filesystem observations remain workspace-scoped. The service exposes no mutation operation.

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

Mount the package beside `dsh-fs`, `dsh-sandbox-policy`, the Session store, and the Typert Gateway; the bundle does so right after the Session Controller. Every method takes the Session identity on the wire, so a Client calls `remote.workspaceFiles.read(sessionId, path, range, signal)`, `stat(sessionId, path, signal)`, `readBytes(sessionId, path, range, signal)`, `list(sessionId, path, signal)`, or `changes(sessionId, signal)` and never names a root itself. The Host reads a live Session header or uses persistence `stat` for a cold Session; it does not activate an Agent, read the event body, or borrow a parent Session's root. Session persistence is optional for live reads, but without it a cold Session cannot resolve and the Gateway returns `gateway/lookup-not-found`.

| Method | Returns | Purpose |
|---|---|---|
| `stat(path)` | `WorkspaceFileStat { absolutePath, version, bytes? }` | Identity, version, and size of one regular file, without content |
| `read(path, { offset?, limit? })` | `WorkspaceFileText` = stat + `{ offset, text, lines, eof }` | One window of lines from a UTF-8 text file; `lines` counts them, so one empty line and a page past the end read differently |
| `readBytes(path, { offset?, length? })` | `WorkspaceFileBytes` = stat + `{ offset, data, eof }` | One window of raw bytes from any regular file, base64-encoded |
| `readAll(path)` | `WorkspaceFileBytes` with `offset: 0`, `eof: true` | Complete raw bytes under `maxFileBytes`; oversized files fail instead of being truncated |
| `readRelated(path, relativePath)` | `WorkspaceFileBytes` | Complete bytes of a file resolved from the base file's directory on the Host |
| `list(path)` | `WorkspaceDirectoryListing { path, entries, truncated }` | Direct children of one directory |
| `changes()` | stream of `WorkspaceFileWatchFrame` | Subscription readiness, then filesystem observations inside the workspace root |

### Addressing and paths

`read`, `readBytes`, `readAll`, `readRelated`, and `stat` accept an absolute path or one relative to the selected Session's workspace root. The composed filesystem decides whether the path is readable; the service does not impose workspace containment on file reads. `readRelated` resolves a relative filesystem path from the base file's directory, including when either file is outside the workspace. These methods report the file's absolute path in the filesystem's execution world. `list` remains workspace-scoped and reports the listed directory relative to that root. `changes` likewise reports only instrumented filesystem observations inside the workspace root.

### Pages

`read` returns one line window, never the whole file. `range.offset` is the 1-based first line and defaults to 1; `range.limit` is the largest number of lines on the page and defaults to `maxLines`, which it may not exceed — a larger limit, or an offset or limit that is not a positive integer, is a `gateway/bad-request`. Lines end at `\n`, and a final `\n` terminates the last line rather than starting an empty one, so a two-line file has two lines. The page's `text` joins its lines with `\n` and carries no terminator after the last; `eof` is true when the page includes the file's last line, and an offset past the end returns an empty page with `eof` true. Every page also carries the file's `version` from the stat that preceded it, so a consumer can tell a fresh page from a stale one, and `bytes`, the complete file's size when the backend reports it. The service reads the file only up to the first character past the page, so a very large file costs one page of memory per request.

### Byte windows

`read` pages by lines and never by bytes; a byte window is `readBytes`. `range.offset` is the 0-based first byte and defaults to 0; `range.length` is the largest number of bytes in the window and defaults to `maxBytes`, which it may not exceed — a longer window fails with `too-large` instead of arriving shortened, and an offset or length that is not an integer in range is a `gateway/bad-request`. The window comes back as base64 `data`, shorter than `length` at the end of the file and empty at or past it; `eof` is true when the window includes the file's last byte. Nothing is decoded and nothing is refused as binary, so an image or a NUL-laden file reads where `read` fails with `not-text`. The same `version` and `bytes` ride along as on a page.

### File-read and directory checks

Every operation first uses `lstat` to reject a missing path, a final symlink, or the wrong file kind. File operations then resolve and read through the composed filesystem without an additional workspace-containment check. `list` alone requires the resolved directory to remain inside the workspace root. The configured page, window, complete-file, and listing caps still apply. Text pages additionally reject invalid UTF-8 and NUL bytes; byte reads do not decode content. An empty path is a `gateway/bad-request`.

### The change feed

`changes` is a `stream` Remote. A generation registers its observation queue and resolves the Session workspace root before yielding `{ kind: 'ready' }`. It then yields `{ kind: 'change', change }`, where `change` is `{ absolutePath, version }` for a present file or `{ absolutePath, absent: true }` for one observed gone. The source is `fs/observed`, filtered to targets inside that root; the operating system is not watched. Observations after the generation's first pull are queued, including while the root resolves. The generation ends on cancellation or plugin disposal.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | `2097152` (2 MiB) | Inclusive byte cap on one page's text and on one byte window; a larger page or window fails |
| `maxFileBytes` | `33554432` (32 MiB) | Inclusive complete-file cap for `readAll` and `readRelated`; larger files fail with `too-large` |
| `maxLines` | `5000` | Default and largest page size in lines; a larger `limit` is refused |
| `maxEntries` | `2000` | Cap on returned directory entries; the rest is dropped and reported cut |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-workspace-files) is the exhaustive source for every accepted field and its JSDoc.

### Failures

Each failure is one `RemoteError` code with typed details, declared in [`src/types.ts`](src/types.ts): `workspace-file/not-found`, `workspace-file/outside-workspace` (directory listing only), `workspace-file/too-large` (with `limit`, the applicable page, window, or complete-file cap), `workspace-file/not-text`, `workspace-file/not-regular-file` (`kind`: `directory`, `symlink`, or `other`), and `workspace-file/not-directory` (`kind`: `file`, `symlink`, or `other`). Callers branch on the code, never on message text.

### Client file resources

The browser export registers the `file` provider into `ctx.resources` and requires `resources`, `remote`, and `remote.workspaceFiles`. The bundle's single `workspace-files` row supplies both faces; the Client has no separate configuration. A component reads `WorkspaceFileStat { absolutePath, version, bytes? }` metadata through `useResource<'file'>(address)` and fetches content separately through Remote reads. Any UI, including Global components, shares the observation for the same complete address.

A `session/<sessionId>/<path>` address carries the authorizing Session and a relative or absolute path; leading slashes are preserved, as in `dsh-resource://file/session/s//etc/hosts`. The Host receives the path unchanged and owns resolution and access checks; the Client needs no Session `cwd`. `absolute/<path>` remains parseable but has no authorizing Session and fails with `workspace-file/unknown-workspace`, without borrowing current or Tab Session. Unsupported addresses fail with `workspace-file/unsupported-address`. [Workspace-path](../../util/workspace-path/README.md) owns the grammar; the generic Resource layer knows only the address and `signal`.

The provider waits for the Host's `ready` frame before its first `stat`, queues changes during the read, then binds the follower to `stat.absolutePath`. Both queued and live changes match that Host-returned path. A new write version updates metadata while retaining the last byte size; duplicate versions are ignored. An absent notice re-stats the file. A failed stat keeps the address followed; a later write can recover it, and any Session write can trigger a retry before the first successful path binding. Frames are `RemoteResult` values, and programming exceptions remain uncaught.

One supervised `changes` stream serves every followed file in a Session. Followers match absolute paths with backslashes normalized to slashes. Carrier loss reconnects through the Gateway supervisor; a Host-ended or terminally failed feed ends its followers and leaves their last metadata readable until reopened. The last follower leaving disposes the stream, a successor waits for that disposal, and plugin teardown awaits all pending closes. The provider declares `ResourceProtocolMap.file`; the text preview declares its Sidebar line-navigation parameters.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Reads through `ctx.fs` use the backend's read authority; the sandboxing backend fences writes and edits, not reads. A Typert lookup derives `WorkspaceFileScope` from a live Session header or the persistence service's header-only `stat`, so cold subagent Sessions need neither Agent activation nor event-body reads. The service adds regular-file checks and bounded transfer, while workspace containment belongs only to directory listing and change observation. A page is cut from `streamText`, which decodes and rejects non-UTF-8 chunk by chunk: the cutter counts lines before the window without keeping them, admits each in-window segment against the byte cap before buffering it, and returns at the first character past the window. One `stat` before the stream names the version and size the page reports.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `WorkspaceFiles`: the `workspaceFiles` service and Remote namespace, `Config`, the gates, the page cutter, `read`, `readBytes`, `readAll`, `readRelated`, `stat`, `list` |
| [`src/changes.ts`](src/changes.ts) | `WorkspaceChangeFeed`: `fs/observed` subscription and one queue per open `changes` generation |
| [`src/types.ts`](src/types.ts) | Wire types and the `RemoteErrorDetailsMap` codes, published as `./types` for Client packages |
| [`src/client/index.ts`](src/client/index.ts), [`provider.ts`](src/client/provider.ts), [`change-feed.ts`](src/client/change-feed.ts) | Browser plugin, file metadata, and per-Session change feed |
| [`src/client/types.ts`](src/client/types.ts), [`remote.ts`](src/client/remote.ts) | Resource values, parameters, Client error codes, and generated Remote types |
| — | No runtime invariant companion is published; every Host answer is derived from `ctx.fs` and the sandbox policy at call time. |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem capability](../../fs/fs/README.md) — the `ctx.fs` contract this service reads through, including `fs/observed` and `readByteRange`.
- [Sandbox policy](../../sandbox/sandbox-policy/README.md) — where the Session's workspace root comes from.
- [Remote assembly](../../api/remotes/README.md) — how Client packages reach the `workspaceFiles` namespace.
- [Client resources](../../client/resources/README.md) — the resource model, `useResource`, pins, and provider lifetime.
- [Workspace path helpers](../../util/workspace-path/README.md) — `fileAddressFor` and `parseFileAddress`, the `dsh-resource://file/…` address grammar both ends share.
- [Sidebar text preview](../../client/ui-sidebar-documentpreview/README.md) — the tab type that follows a file through the `file` provider and reads its pages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, contributes no prompt section, and appends no session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Instrumented operations only** — `changes` relays `fs/observed` emissions; a file changed by a subprocess, a shell command, or the user's editor produces no frame.
- **Directory scope only** — `list` and `changes` stay inside the Session workspace even though file preview reads may use any path readable by the filesystem backend.
- **No total line count** — a page reports `eof`, not how many lines follow; a consumer that needs the total pages to the end or estimates from `bytes`.
- **One giant line has no page** — a single line above `maxBytes` fails `too-large` at every window that includes it, because pages are cut by lines, not bytes.
- **Reads are not transactional** — result metadata comes from stat before content is read; a concurrent write can make the reported version and returned contents differ.
- **Unbounded generation queue** — a `changes` generation buffers every contained observation until its consumer pulls; a stalled consumer grows Host memory for the life of the stream.
- **`maxEntries` bounds the answer, not the listing** — `list` asks `ctx.fs.listDir` for every child and cuts the array afterwards, so a directory far above the cap still costs the Host the whole listing (on `fs-local`, one stat per child); bounding that work needs a limit on the filesystem seam's `listDir`.
- **Dead feeds retain metadata** — after the Host ends `changes` or the stream fails terminally, open values retain their last state until reopened.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
