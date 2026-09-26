# Agent Note: Workspace file service

Status: implemented

English | [中文](2026-09-05-workspace-files-service.zh.md)

## Problem

The Web client needs to look at files inside a session's workspace from a browser that may not be on the Host machine: a file the agent produced, the path a `read` tool row names, later a file tree and previews of files that are neither small nor text. The one endpoint that read a workspace file over the wire lived on the Session Controller as `workspace-file.ts`, beside session lifecycle it had nothing to do with. It returned a whole file under one total byte cap, so a large log could not be looked at even in part and a binary could not be looked at at all; it had no `stat`, no listing, and no change signal, so a preview could not learn that the agent had rewritten the file without re-reading it; and its result named the file by a Host `url`, a spelling nothing on the Client used as an address.

Two constraints frame the service. File reads through `ctx.fs` use the Session's composed filesystem backend, whose read authority may extend outside the workspace, while directory-tree and change-feed consumers are workspace-rooted. The service preserves the backend's read decisions for regular files while enforcing file-kind and bounded-buffer checks; `list` and `changes` retain workspace containment. And `dsh-fs` exposed one raw-byte read, `readBytes(target, signal, maxBytes)`, which refuses any file longer than its cap: correct for an image the model ingests whole, useless for one window of a large file.

## Decision

`packages/api/workspace-files` (`@deepseek-ai/dsh-api-workspace-files`) owns the Host `ctx.workspaceFiles` service, the `workspaceFiles` Remote namespace, and the Client `file` provider that turns `stat` and `changes` into live metadata for the [resource model](2026-09-05-client-resource-model.md); [dual-face packaging](2026-09-07-workspace-files-dual-face-package.md) governs their package organization. File methods resolve relative paths from the workspace root but inherit the Session filesystem backend's read authority; `list` and `changes` remain workspace-scoped. The [workspace file read authority](2026-09-09-workspace-file-read-authority.md) owns this split and its security consequences. Results name files by their absolute path in the filesystem's execution world, and content is bounded by page, byte window, or complete-file cap. The byte window rides on a new `dsh-fs` seam, `FileSystem.readByteRange`, implemented by every provider. The Session Controller carries no workspace-file code.

### Package topology

[dual-face packaging](2026-09-07-workspace-files-dual-face-package.md) supersedes this note's choice of separate Host and Client packages; the file service, paging, and change-feed decisions here remain in force. The [workspace file read authority](2026-09-09-workspace-file-read-authority.md) supersedes the original workspace-containment choice for file methods. Host and Client compile in separate leaf configurations, share wire types, and the Client does not import the Host runtime entry.

| Face | Package | Files | Depends on |
|---|---|---|---|
| Host | `api/workspace-files/tsconfig.host.json` | `src/index.ts` (`WorkspaceFiles`, `Config`, gates, pager), `src/changes.ts` (`WorkspaceChangeFeed`), `src/types.ts` (wire types, error codes) | `dsh-fs`, `dsh-sandbox-policy`, `dsh-typert-protocol`, `dsh-session`, `dsh-session-persistence` |
| Client | `api/workspace-files/tsconfig.client.json` | `src/client/index.ts` (plugin body), `provider.ts`, `change-feed.ts`, `remote.ts`, `types.ts`, and shared `src/types.ts` | `dsh-api-gateway/client`, `dsh-session/types`, `dsh-client-resources`, `dsh-client-ui-slots`, `dsh-util-workspace-path`, `dsh-typert-protocol`, and the package's generated `./remote` |

`api/remotes` and both root aggregates reference the matching Host/Client leaf. The package exports `.`, `./client`, `./types`, `./typert`, and `./remote`, with one `workspace-files` web-app row supplying both faces. The Client plugin injects `['resources', 'remote', 'remote.workspaceFiles']`; the resource model takes result types directly from the protocol package, and the text preview owns the Sidebar parameter declaration, so the Client compilation graph has no reverse dependency on Remote assembly or Sidebar UI.

### The `workspaceFiles` file operations

Every Host method takes `WorkspaceFileScope` first. The `workspaceFileScope` Gateway lookup resolves Session identity. It reads the live Session header or, for a cold Session, `SessionPersistence.stat`; it never activates an Agent, reads the event body, or falls back to a parent Session. The scope carries the selected Session id and its `cwd`, with the sandbox policy's deployment root used only when that header has no `cwd`. A Client passes its Session id and never names a root. The five signatures, as `src/index.ts` declares them:

```ts ignore-check
@Remote async read(workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText>
@Remote async readBytes(workspaceFileScope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes>
@Remote async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>
@Remote async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
@Remote({ mode: 'stream' }) changes(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
```

- **`stat`** returns `WorkspaceFileStat { absolutePath, version, bytes? }`: the file's identity, its opaque freshness token, and its size when the backend reports one. It accepts a regular file only.
- **`read`** returns one window of lines, `WorkspaceFileText = WorkspaceFileStat & { offset, text, lines, eof }`; `lines` counts the page's lines, so a page holding one empty line (`text: ''`, `lines: 1`) and a page past the end (`lines: 0`) read differently. `range.offset` is the 1-based first line and defaults to 1; `range.limit` is the largest number of lines and defaults to `maxLines`, which it may not exceed. Lines end at `\n` and a final `\n` terminates the last line rather than opening an empty one; `text` joins the page's lines with `\n` and carries no terminator; `eof` is true when the page includes the last line, and an offset past the end returns an empty page with `eof` true. The pager walks `streamText`, counts the lines before the window without keeping them, admits each in-window segment against `maxBytes` before buffering it, and returns at the first character past the window, so a file of any size costs one page of memory. The `version` and `bytes` on a page are the stat's, taken before the stream.
- **`readBytes`** returns native bytes with file metadata, offset, and EOF. The required options object selects a complete read under `maxFileBytes` when `range` is absent, or a bounded window under `maxBytes` when present. `range: {}` uses offset zero and the configured window cap; windows can read files above the complete-file cap. The [binary transfer decision](2026-09-17-workspace-file-binary-transfer.md) owns the Remote response encoding.
- **`baseFile`** selects target resolution independently of `range`: the target `path` must be relative and resolves from the base file's directory. The Host applies regular-file checks to both files and preserves backend read authority. [Document Preview](2026-09-08-document-preview-operations.md) owns content loading and address semantics.
- **`list`** returns `WorkspaceDirectoryListing { path, entries, truncated }`: the listed directory as a workspace path relative to the root (empty for the root), its direct children in the backend's stable name order as `{ name, type, size? }`, and whether `maxEntries` cut the list. `type` is `file`, `directory`, or `other`; a symlink child reports the type of what it points to and a dangling one is `other`. A child the listing reports as a directory opens through its resolved target, including a Windows junction, and the listing then names that target; [directory link listing](../bug-fix/2026-09-18-windows-directory-junction-listing.md) owns the rule. Dotfiles are listed; nothing is filtered.
- **`changes`** yields `WorkspaceFileWatchFrame`: `{ kind: 'ready' }` after the observation queue is registered and the workspace root resolves, followed by `{ kind: 'change', change }`. The `WorkspaceFileChange` payload is `{ absolutePath, version }` for a present file or `{ absolutePath, absent: true }` for one observed gone. Its source is `fs/observed` inside the workspace root, never an OS watcher. Observations after the first pull are queued, including during root resolution; cancellation or plugin disposal ends the generation.

### Paths on the wire

Two path vocabularies leave the service, and each method uses exactly one. `read`, `readBytes`, `stat`, and `changes` name a file by `absolutePath`: its absolute path in the filesystem's execution world, symlinks resolved (`ctx.fs.processPath(target)`), so the Client provider matches a change frame to an open address by absolute path: the Client sends the address's path unchanged to the Host and binds the follower only to a successful `stat.absolutePath`, without reading a Session summary's cwd. `list` speaks workspace paths — the same syntax its `path` argument accepts, absolute or relative to the root — because its consumer is a tree rooted there. The field is called `absolutePath` and not `url` because it is not a resource address; the address grammar belongs to `dsh-util-workspace-path` and is described with the resource model. Input paths to `read`, `readBytes`, `stat`, and `list` are absolute or relative to the session's workspace root, never to the backend's own cwd; `readBytes` with `baseFile` resolves the target from that file's directory.

`version` is an opaque string a consumer compares for equality and never parses: the local backend derives it from device, inode, size, and nanosecond mtime and ctime, so a rewrite that leaves the content identical still changes it. `offset` means a line on `read` and a byte on `readBytes`; the two units never mix, and `eof` on either means the window reached the file's end.

### File checks and workspace containment

`read`, `readBytes`, and `stat` share regular-file checks and then rely on the filesystem backend's read authority. `list` shares path inspection but also checks workspace containment, while `changes` filters observations to the workspace root. The service applies the following checks:

1. **The path itself.** `lstat` inspects the path before anything follows it: a missing path is `not-found`, and a symlink — wherever it points, including back inside the workspace — is `not-regular-file` (kind `symlink`) for the file methods. `list` instead follows a final link and judges the resolved target: the target must stat as a directory, and a link to a file or a link whose target is gone is `not-directory` (kind `symlink`). An empty path is a `gateway/bad-request`.
2. **Workspace containment for `list`.** The directory resolves to a target and `ctx.fs.contains(root, target)` decides, where `root` is the `WorkspaceFileScope.workspaceRoot` resolved from the selected Session header. A `..` traversal or an absolute directory outside the root is `outside-workspace`. `changes` applies the same backend containment predicate to observed targets.
3. **The caps.** A page or window above `maxBytes`, or a `read` asking for more than `maxLines`, is refused, never shortened, because a silently cut page reads as the whole page; a listing above `maxEntries` is cut and says so. Complete and related-file reads are refused above `maxFileBytes`.
4. **Text.** For `read` only: content that is not UTF-8 up to the end of the page, a NUL byte in the backend's 8 KiB opening sample, or a NUL byte anywhere in the page is `not-text`; bytes past the page are not inspected.

After path inspection the file methods `stat` the resolved target once more, because the file may have gone or changed kind before the read: a vanished file is `not-found` and a replaced one `not-regular-file` with the new kind. For `list`, an outside entry whose type already disqualifies it reports its kind before its position; a final link resolves and passes containment before its target kind is read.

### Failures

Each failure is one `RemoteError` code with typed details, declared beside the throwing code and discriminated by code, never by message.

| Code | When | Details |
|---|---|---|
| `workspace-file/not-found` | no entry at the path, or the file vanished after the gates | `{ path }` |
| `workspace-file/outside-workspace` | a `list` target is not inside the workspace root | `{ path }` |
| `workspace-file/too-large` | a page's text or byte window exceeds `maxBytes`, or a complete read exceeds `maxFileBytes` | `{ path, limit }` |
| `workspace-file/not-text` | invalid UTF-8 up to the page's end, or a NUL byte in the sample or the page (`read` only) | `{ path }` |
| `workspace-file/not-regular-file` | `read`, `readBytes`, or `stat` on something that is not a regular file | `{ path, kind: 'directory' \| 'symlink' \| 'other' }` |
| `workspace-file/not-directory` | `list` on something that is not a directory | `{ path, kind: 'file' \| 'symlink' \| 'other' }` |
| `workspace-file/unsupported-address` | Client-minted: a resource address this provider cannot serve | `{ address }` |
| `workspace-file/unknown-workspace` | Client-minted: an `absolute` address, which carries no Session | `{ address }` |
| `gateway/bad-request` | an empty path, or an `offset`, `limit`, or `length` that is not an integer in range | `{}` |

The set is append-only: a code may be added, and none is renamed or removed, because consumers branch on these strings across the wire.

### Configuration

Four fields, all validated positive integers changeable from `cordis.yml`, and no other tunables: `maxBytes` (default 2,097,152, 2 MiB) is the inclusive cap on one page's text and on one byte window; `maxLines` (default 5,000) is the default and largest page in lines; `maxEntries` (default 2,000) is the cap on returned directory entries; `maxFileBytes` (default 33,554,432, 32 MiB) caps complete and related-file reads. Paged and windowed reads impose no whole-file size cap.

### The `readByteRange` seam in `dsh-fs`

A byte window of a large file needs a filesystem read bounded by the window, and `FileSystem` had only `readBytes(target, signal, maxBytes)`, which bounds by the whole file. `dsh-fs` therefore gains a second raw-byte primitive:

```ts ignore-check
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
```

It returns the bytes at `[offset, offset + length)`, shorter when the file ends inside the window and empty when `offset` lies at or past the end. The window is the bound: a backend transfers at most `length` bytes beyond the prefix it skips to reach `offset` and never buffers the whole file, so the caller's cap on `length` is the guard against unbounded buffering, sitting beside `readBytes`'s bound rather than replacing it. The parameter order follows `readText`, `streamText`, and `listDir` — target, then the operation's own arguments, then an optional signal — rather than `readBytes`'s signal-in-the-middle form, which is the one exception in the class. Both `offset` and `length` are non-negative integers by precondition; the seam is a typed same-process boundary and validates nothing, and the Remote method validates at the wire.

`fs-local` opens `createReadStream(targetKey, { start: offset, end: offset + length - 1 })` after the same regular-file stat as its other reads, returning an empty array for `length` 0 without opening a stream; `fs-sandbox` extends `LocalFileSystem` and inherits it. The four test doubles that extend `FileSystem` implement the method too.

### The Client `file` provider

The Client export registers one `ResourceProvider<'file'>` into `ctx.resources` for the plugin's lifetime and declares `ResourceProtocolMap.file`. The Document Preview package registers this package's exported `WorkspaceFileParams` as `SidebarRightResourceParamsMap.file`.

- **The value is metadata**, `WorkspaceFileStat { absolutePath, version, bytes? }`; content never rides the stream because content can be arbitrarily large and a stream is for pushing change, not payload. A consumer reads pages with `read` (or windows with `readBytes`) and compares versions to know when they are stale; freshness and refresh belong to each consumer, not the shared observation.
- **The address names the file; its scope selects the Session.** A `session` address's relative or absolute path reaches the Host unchanged; the workspace root supplies the base for a relative path, and the Session filesystem backend decides read access. Client cwd is not a prerequisite. An `absolute` address has no Session and fails with `workspace-file/unknown-workspace`; no current or tab Session is borrowed. Unsupported grammar yields `workspace-file/unsupported-address`. These two Client errors end the stream.
- **The frames.** The first frame is a `stat` or its failure as an `ok: false` frame; the provider throws and catches nothing, because the Remote face never rejects and a throw inside a provider stream is a programming error left to surface. A Host write carrying a version the value does not hold yields that version with the byte count kept and no stat; a frame carrying the held version is dropped. A reported disappearance stats again — still there is fresh metadata, gone is a `not-found` frame with the previous value left for display. The follow is on the address, not the file: after a failed stat the stream continues, so the agent creating the file brings the resource live. Aborting the signal ends the stream silently.
- **One `changes` subscription per Session.** The first follower opens `remote.$stream`, the last release disposes it, and successor streams and plugin teardown await pending closes. The Client starts its first `stat` only after accepting Host `ready`; sending a local WebSocket request is not Host acknowledgement. A follower registers by address, queues changes before its path is known, then filters queued and live frames by the successful stat's `absolutePath`, normalizing backslashes to slashes. Any Session write can trigger a re-stat before the first successful binding. Gateway supervision reconnects carrier loss; Host end or terminal failure ends followers and retains their last metadata until reopened.
- **Navigation parameters.** `SidebarRightResourceParamsMap.file` is `WorkspaceFileParams { line?: number }`, a 1-based line to reveal. A line travels as a navigation parameter and not as part of the address, because the file is one piece of content whether it opens at the top or at line 400.

### Related notes

The [resource model](2026-09-05-client-resource-model.md) owns `ctx.resources`, `useResource`, the `dsh-resource://<type>/…` address grammar, and the reasoning for one resource per address; the [text preview and file tree](../feature/2026-09-05-sidebar-text-preview-and-file-tree.md) are the shipped consumers of `read`, `list`, and the `file` provider; the [right Sidebar docking infrastructure](../feature/2026-09-04-right-sidebar-docking-infrastructure.md) is the surface they open into; [workspace file links](../feature/2026-07-31-web-workspace-file-links.md) is where serving files over HTTP was rejected. Anyone extending this system reaches the same five methods through `remote.workspaceFiles` and the same `file` resource through `useResource<'file'>`; the wire types are published as `@deepseek-ai/dsh-api-workspace-files/types`. The [workspace file read authority](2026-09-09-workspace-file-read-authority.md) owns Host read access and the HTML security trade-off; [Document Preview](2026-09-08-document-preview-operations.md) owns content loading and per-tab freshness.

## Alternatives considered

**Keeping the workspace file endpoint on the Session Controller.** The first form: one `read` under a total byte cap, registered as a sub-plugin of the Session Controller because that is where the wire entry already was. Rejected because a Workspace File service is its own capability — reading and statting files plus listing and observing the workspace — and those queries belong together, while the Session Controller's concern is session lifecycle. The move also let the service grow to five methods without the Controller's file gaining a second purpose.

**A dual-face package with reverse UI dependencies.** The split-package choice followed two project-reference cycles after `api/remotes` referenced the Client leaf: the resource model imported Remote assembly for result types, and the file provider imported Sidebar UI for its parameter map. TypeScript rejected these cycles with `TS6202`. [dual-face packaging](2026-09-07-workspace-files-dual-face-package.md) supersedes that split: result types come directly from the protocol package, and Sidebar parameter registration belongs to the text preview; both root aggregates retain explicit compiler entries.

**Serving navigable workspace documents.** Rejected on origin grounds; the [binary transfer](2026-09-17-workspace-file-binary-transfer.md) returns multipart data while HTML remains isolated in a Blob iframe.

**Log-reachable or workspace-contained authorization for file reads.** The one precedent that sends file content over the wire, command attachments, authorizes only files that appear in the session log. That excludes typed paths, while workspace containment excludes readable files elsewhere on the Session backend. The [workspace file read authority](2026-09-09-workspace-file-read-authority.md) instead makes the backend's read decision authoritative and keeps containment only for workspace-shaped operations.

**Whole-file read and slice for the byte window.** The interim form of `readBytes` read the file from its start to the window's end through `readBytes(target, signal, offset + length)` and sliced. It cannot read a window of a file longer than that end — the seam refuses such a file as too large — so no window could ever report `eof: false`, which contradicts the reason the method exists. Rejected in favour of the `readByteRange` seam, whose bound is the window.

**Naming the file field `url` (or `hostUrl`).** The Session Controller's `WorkspaceFileText.url` was the Host's `file:` URL of the file. Rejected once resource addresses existed: a URL on the wire reads as an address, and this one was not one — it was a differently encoded spelling of the same path the address carries, which the Client had to decode to match change frames. A wire field is named by what it is, so the field is `absolutePath` and the `changes` frames carry the same field.

**A default `readByteRange` in the `FileSystem` base class.** A non-abstract default over `readBytes` would have spared the test doubles a method but could only be implemented by reading the whole file up to the window's end, the very behaviour rejected above, or by passing an unbounded cap. Abstract, with every provider and double implementing it.

**String-prefix containment for workspace operations.** Comparing resolved path strings against the root is simpler than `fs.contains`, but `resolve` realpaths, so a symlink that leaves the root resolves to a path outside it while a prefix test on the unresolved spelling passes; and a prefix test on the resolved spelling still needs the backend's notion of "same file". The filesystem decides containment for `list` and `changes`.

## Consequences

- Workspace file access belongs to the Host/Client faces of `api/workspace-files`; the Session Controller carries neither implementation, and compiler and runtime entries stay separate. Header-only Session scope lets ordinary, subagent, live, and cold Sessions resolve their own relative paths without an Agent lifecycle or parent fallback.
- A file of any size opens: text by line page, anything by byte window, each costing one page or window of memory on the Host; complete reads instead enforce `maxFileBytes`; the cost is that a consumer assembles pages itself and that a single line above `maxBytes` has no page at all, because pages are cut by lines.
- Every filesystem provider offers windowed raw reads; `fs-local` seeks directly to the requested offset.
- Paths on the wire are canonical: `absolutePath` and change frames spell a file with symlinks resolved. A follower binds to successful `stat.absolutePath`, so another spelling of the same file — a workspace root reached through a symlink — uses that canonical change key.
- Change frames report the agent's own operations only. A file edited by the user's editor, a shell, or a subprocess raises no frame; an agent merely reading a file that something else changed does raise one, because the read observes a new version.
- File-kind inspection precedes backend reads, and `list` reports kind before an outside position. A page's `version` may be one write behind its content, and a stalled `changes` consumer grows Host memory because a generation's queue is unbounded; each is a known trade-off recorded in the package README.
- The `file` resource pushes change, not content, so a preview learns a file moved on without a payload and reads the pages it wants; a failed open keeps following the address, so the agent creating the file brings the tab live without user action.
- Office authorization probes use `readBytes` with a one-byte `range`; Document Preview uses the same method without `range` for complete-file formats.

## Testing

Host specs in `packages/api/workspace-files/tests` exercise header-only scope resolution for live and cold subagent Sessions, the deployment fallback, missing identities, and lookup disposal; the paged read (whole file, nested path, empty file, multi-byte UTF-8, the line window's edges, defaults and refused limits, carriage returns kept); the byte window (defaults, a middle window with more following, tail windows exact and short, past-end and empty files, NUL and invalid UTF-8 round-tripping through `Uint8Array`, version parity with `stat`, the cap as `too-large`, bad ranges, a window of a file far above the cap, and `eof` inferred without a size); `stat`; outside-workspace reads and backend refusals; `list` with containment, truncation, directory links, links whose target is gone, and `not-directory`; and the `changes` stream driven by `fs/observed` and filtered by root. Client specs cover the provider's frames, the change feed, unsupported addresses, and registration and disposal. `fs/fs` and `fs-local` specs pin `readByteRange`; `dsh-util-workspace-path` specs pin the file-address grammar. The connection fixture serves `stat`, paged `read`, `list`, and an opt-in `changes` frame for the web e2e suite.

## Deferred

- A bound on a `changes` generation's queue.
- Write and search operations; the service is read-only.
- Scopes other than `session` in the file address; the grammar leaves room, the provider serves one.
