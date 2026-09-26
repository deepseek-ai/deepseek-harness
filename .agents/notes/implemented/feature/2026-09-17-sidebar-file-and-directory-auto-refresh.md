# Agent Note: On-demand watching and automatic refresh for Sidebar previews and file trees

Status: implemented

English | [中文](2026-09-17-sidebar-file-and-directory-auto-refresh.zh.md)

## Problem

The Sidebar's Document Preview and Files panels need to reflect current disk state. Changes come from Harness file tools, shell commands, user editors, and other processes; observing only Harness file operations is insufficient.

The starting implementation has both read paths but no complete automatic-refresh path.

| Object | Starting behavior | Gap |
|---|---|---|
| File Resource | `ResourceProvider.open()` supplies initial metadata and later changes; `ResourceRegistry` owns subscriptions and retention; components read through `useResource` | File changes do not come from an OS watcher |
| Document Preview | `TextPreview` compares Resource and content versions and provides reload for three loading modes | A change only prompts the user to reload |
| Workspace file events | `WorkspaceFiles.changes()` forwards the current Session's `fs/observed`; the Client filters by file | The Host does not know which paths are followed; external editors and shell writes produce no such events |
| Files panel | `filesFace` lists directories; `createFilesStore` retains loaded levels and expansion state | Creation, deletion, and renaming require manual refresh; reopening an expanded directory can show old cached entries |

`Resource` holds file metadata, not preview contents. Document Preview or its selected renderer reads the contents. Metadata updates and content reloads therefore remain separate responsibilities: the generic Resource acquires no content cache, and renderers do not directly manage filesystem watchers.

## Decision

On-demand observation connects the existing FS, Workspace file stream, Resource, and Sidebar components. Files and directories share OS watching and the existing Remote stream transport, but consume them differently.

- Document Preview follows the current file. Its Resource publishes new metadata, and the preview invokes its existing reload. The HTML root and referenced CSS/JS files join one `ResourceGroup`; any member change invalidates the whole HTML preview.
- Files manages reads and watchers through a directory-node tree. Each open node loads and watches only its direct entries. The Client loads and subscribes to exactly the subtree levels it opens, without traversing unopened descendants.
- Collapsing a directory releases that directory's watch and those of its hidden descendants. Reopening subscribes and reads again; the old cache is not treated as current.
- Watches carry only metadata or invalidation. Contents still use the existing file readers; directory contents still use `list()`.
- Local Chokidar watches use OS events, without polling the whole Workspace or recursively scanning all descendants by default.
- Both panels retain manual refresh and automatic-refresh functionality, but temporarily hide the automatic-refresh icon button. State and toggle logic remain; new Tabs default to enabled. Hiding the control does not stop observation or automatic refresh.

Notifications invoke existing reload/list operations; a failed reload does not retain previous preview content. The following sections describe the implementation's responsibilities, data flow, and verification.

## Implementation and responsibilities

### FS and Host

| Class or type | File | Responsibility |
|---|---|---|
| `FileSystem` | [fs/src/index.ts](../../../../packages/fs/fs/src/index.ts) | Declare single-target `watch(target, changed, signal)`: a file observes itself; a directory observes its direct entries. Resolve with an async close function once ready. The base implementation rejects `FS_IO_ERROR`, so a provider without watching states nothing and adds no FS error code |
| `FsTarget` | [fs/src/types.ts](../../../../packages/fs/fs/src/types.ts) | Reuse the existing target type, without another FS watch-event system or upper-layer parsing of `targetKey` |
| `LocalFileSystem` | [fs-local/src/index.ts](../../../../packages/fs/fs-local/src/index.ts) | Watches a file's parent with target-only filtering, or the directory itself for directory targets; awaits Chokidar readiness and closure; owns the Chokidar dependency |
| `SandboxedFileSystem` | [fs-sandbox/src/index.ts](../../../../packages/fs/fs-sandbox/src/index.ts) | Inherit local read-only observation without duplicating the watcher; retain its write and edit policy checks |
| `SshFileSystem` | [fs-ssh/src/index.ts](../../../../packages/ssh/fs-ssh/src/index.ts) | Inherits the base `FS_IO_ERROR` rejection; the Host converts it to a `workspace-file/watch-unsupported` `RemoteError`, without importing or checking an `FsError` runtime class across packages or passing remote `processPath()` values to local Chokidar |
| `WorkspaceFiles` | [workspace-files/src/index.ts](../../../../packages/api/workspace-files/src/index.ts) | Use `changes(scope, path, signal)` with only the target path. Host stat determines whether directory containment applies, including after type changes; ordinary files retain file-read authority |
| `WorkspaceChangeFeed` | [workspace-files/src/changes.ts](../../../../packages/api/workspace-files/src/changes.ts) | Establish the target watch in the existing follow path and emit readiness and changes. Retain the queue and operation-observation input; filter by target before emission without rewriting dispatch |
| `ChangeFollower` | [workspace-files/src/changes.ts](../../../../packages/api/workspace-files/src/changes.ts) | Receive operation observations and OS notifications; handle watch errors, close independently of generator pulls, and await watcher closure |
| `WorkspaceFileWatchFrame` | [workspace-files/src/types.ts](../../../../packages/api/workspace-files/src/types.ts) | Reuse `ready`/`change` frames for a path-only request, without a request kind or separate directory frame format |

### Client and Sidebar

| Class, function, or type | File | Responsibility |
|---|---|---|
| `ChangeFeed`, `SessionFeed`, `Follower` | [workspace-files/src/client/change-feed.ts](../../../../packages/api/workspace-files/src/client/change-feed.ts) | Key streams by Session and target path; reuse readiness, path binding, cancellation, and reconnect logic without reorganizing classes just to rename them |
| `createFileResourceProvider` | [workspace-files/src/client/provider.ts](../../../../packages/api/workspace-files/src/client/provider.ts) | Pass the address's Session and path to the target stream; publish complete metadata initially and after notifications, rather than replacing `version` while retaining stale `bytes` |
| `ResourceRegistry`, `ResourceProvider`, `UseResource` | [Resource definitions](../../../../packages/client/resources/src/client/contract.ts), [ResourceRegistry](../../../../packages/client/resources/src/client/resources.ts) | Keep existing streaming, retention counts, and subscriptions; add neither a second `onChange` nor a generic content-reload API |
| `TextPreview` | [TextPreview.tsx](../../../../packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx) | Invoke existing reload when a Resource or group changes and automatic refresh is enabled; retain errors and manual refresh, with the separate automatic-refresh button temporarily hidden |
| `textFace`, `TabReads`, `createTextStore` | [Preview face](../../../../packages/client/ui-sidebar-documentpreview/src/client/face.ts), [Preview store](../../../../packages/client/ui-sidebar-documentpreview/src/client/store.ts) | Own one group per Tab; add default-enabled `autoRefresh` and pending-refresh flag `resourcesDirty`; reuse content-read generations and `loadRevision` |
| Package-private `ResourceGroup` | [resource-group.ts](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/resource-group.ts) | Observes members through existing `resources.source(address)`; `add` joins a resource, `set` reconciles full membership, and `close` releases all members without changing the generic Resource service |
| `DocumentBodyOwner`, `HtmlBody`, `createReadHtmlRelative` | [Renderer inputs](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts), [HTML body](../../../../packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx), [Related-file reader](../../../../packages/client/ui-sidebar-documentpreview/src/client/html/read-relative.ts) | Renderers declare read members through `addResource` and publish the current dependency list through `setResources`; HTML adds CSS/JS resources from Host-reported paths after each read returns and releases unreferenced members after parsing |
| Document renderers | [DocumentContent](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts) and renderer directories in the same package | Do not watch directly; keep consuming text, bytes, or renderer revisions; `failed()` ends renderer loading without recording a successful version. Check cancellation of previous work, release of old objects, and retention of existing view preferences during refresh |
| `filesFace`, `FilesInjected` | [Files face](../../../../packages/client/ui-sidebar-files/src/client/face.ts) | Remain the existing business entry point, directly owning each Tab's root node; bind directory reads and change streams and forward expand, collapse, refresh, and automatic-refresh operations without a new `FilesController` |
| Package-private `DirectoryNode` | [directory-node.ts](../../../../packages/client/ui-sidebar-files/src/client/directory-node.ts) | Represents one open directory, owning its stream, read state, and open children; handles local refresh, expansion, recursive closure, and propagation of automatic-refresh state; `setExpanded` updates pending restoration from the latest expansion preferences |
| `createFilesStore`, `FilesTabState`, `LevelState` | [Files store](../../../../packages/client/ui-sidebar-files/src/client/store.ts) | Retain expansion, scrolling, and displayed directory data; distinguish initial loading from refresh over existing content to avoid unmounting subtrees on every background read; hold no watcher or AbortController |
| `FilesBody`, `Level`, `Entry` | [FilesBody.tsx](../../../../packages/client/ui-sidebar-files/src/client/FilesBody.tsx) | Delegate expansion, collapse, refresh, and panel unmount to injected callbacks; render node results without scanning the entire tree into a watch set, using existing framework hooks and store reads |
| Files registration | [Files client/index.ts](../../../../packages/client/ui-sidebar-files/src/client/index.ts) | Add a directory-change callback to the existing `filesFace`; keep async effects in injection, without importing another feature plugin's runtime exports |

## Watch requests and notifications

### One stream per explicit target

Each request names one target path. The Host determines its current type through `stat`; the Client supplies no file/directory kind.

```text
changes(sessionId, path, signal)
changes(scope, path, signal)
```

The Host method still receives resolved Session context through `WorkspaceFileScope`. The Client supplies a Session id; it cannot forge the Host's working directory or permissions.

The Host checks Workspace containment whenever the current target is a directory, including when an absent or ordinary-file target becomes a directory. Ordinary files outside the Workspace remain readable and watchable through the selected FS.

| Notification | Contents | Consumer action |
|---|---|---|
| Ready | This generation's target watch is established | Perform initial or reconnect `stat()`/`list()` and consume changes queued during the read |
| File present or updated | Existing path and version notification; Client stats again | Update Resource path, version, and size from the complete result; reread contents when automatic refresh is enabled |
| File absent | Target path and absence state | Resource reports unavailability; preview retains loaded content and shows the error |
| Directory invalidated | `change` frame in that directory's target stream | Call only that directory's `list()` again, without deduplicating by directory version or refreshing the entire tree |
| Watch failure | Initialization failure reports `workspace-file/watch-unsupported`; runtime errors end the watch | The Client handles failure where it consumes the watch; ordinary reads and manual refresh remain available, without reporting file deletion |

Notifications need neither file contents, complete directory listings, nor per-change patches. Paths identify filenames; current stat supplies size. Modification time used only for freshness remains part of the backend version token, without UI token parsing or another timestamp comparison.

Resource path, version, and size come from the same stat. Keep the existing small notification followed by Client stat instead of expanding the event protocol to save one request. Directory invalidation cannot depend only on directory mtime: a direct child's size or type can change `list()` output, so relevant child events invalidate that level.

### OS watching and access scope

- `FileSystem.watch()` accepts a target resolved by its provider; the FS provider owns the meaning of local or remote paths.
- File watching retains file-read access rules. Existing previews may read some paths outside the Workspace through the selected FS; directory-tree containment must not be imposed on those files.
- Directory watching retains `list()`'s Workspace scope and path checks, including after target type changes, without widening browsing authority.
- File watching covers in-place writes, replacement by a temporary file, deletion, and recreation at the same path while the parent directory remains. The local provider watches that parent directly, filters entries and events to the target file, and waits for the parent watcher to be ready before reporting readiness, including when the file does not yet exist.
- A directory watch observes itself and direct entries, without recursively opening unexpanded children. Creation, deletion, renaming, type changes, and visible metadata changes of direct entries invalidate that level.
- Local watching uses OS events. Deployment controls such as write-stability time or event-coalescing windows, if needed, belong in their owner's configuration rather than scattered component constants.
- OS watching drives UI refresh only. It does not fabricate an agent's authoritative `fs/observed` read observation or change the observed-version policy for editing.

## Complete file-preview data flow

```text
Files.openResource / file.link
  → Sidebar.openTab
  → TabDomain → Resource.pin
  → ResourceRegistry → createFileResourceProvider.open
  → changes(sessionId, path)
  → WorkspaceFiles → FsTarget
  → WorkspaceChangeFeed → FileSystem.watch
  → LocalFileSystem → Chokidar
  → ready → Client.stat → ResourceSnapshot

Editor / Shell / file tool → disk
  → Chokidar → LocalFileSystem
  → WorkspaceChangeFeed → FileSystem.stat
  → Remote.change
  → Client.stat → ResourceSnapshot
  → ResourceGroup → TextPreview
  → reloadPages / reloadAll / prepareRenderer
  → DocumentContent / renderer revision
  → renderer
```

Preview content reads may run in parallel with metadata initialization. ResourceGroup uses each member's first metadata as a baseline and forwards only later changes, without first-read version reconciliation.

| Loading mode | Existing refresh entry | Result |
|---|---|---|
| `text-pages` | `reloadPages()` | Retire the old content generation and reread text pages without mixing versions |
| `bytes-complete` | `reloadAll()` | Reread complete bytes for PDF, HTML, image, and other byte consumers |
| `renderer` | `prepareRenderer(..., reload = true)` | Increment `loadRevision`; the renderer cancels its previous load and requests again. Office failures end loading through `failed()`, allowing later file changes to retry |

Ordinary renderers need neither `watch()` nor a new reload interface. Changes to existing `DocumentContent` text, bytes, and revisions already drive reloading.

## HTML ResourceGroup

An HTML preview's group contains the HTML root and CSS/JS files actually read by the existing packer. Every member is an ordinary file Resource, with no separate dependency watcher or file type. The group is package-private and reuses Resource subscriptions and retention counts.

```text
index.html Resource ─┐
theme.css Resource ──┼→ ResourceGroup → resourcesDirty → autoRefresh → HTML reload
page.js Resource ───┘
```

- `addResource(address)` joins a dependency after `readRelated` returns its Host-resolved `absolutePath`. Existing members do not resubscribe, and no content-read version is passed or retained.
- `setResources(addresses)` commits the parsed dependency list. The preview owner always retains the root and releases other members absent from the new list.
- CSS/JS references use the HTML's Session and Host path resolution. A failed read also retains a string `error.details.path` supplied by the Host; without that path, the Client does not guess one.
- A CSS or JS change reloads the complete HTML and creates new iframe content even when the HTML source itself is unchanged.
- Missing dependencies with a Host-reported path remain members. Parsing failures retain already discovered dependencies so their later changes can trigger another load.
- A new member's first metadata establishes a baseline without invalidating the preview. Only subsequent metadata changes notify; initial reads have no additional version reconciliation.
- Group changes set only `resourcesDirty` to `true`. Refresh clears it; another change during reading sets it again. No notification counter or separate read generation is added.
- Closing the preview Tab releases the whole group. Disabling automatic refresh only stops automatic rereads; the group continues observing and recording stale state.

This version covers direct stylesheet links and classic JS scripts already supported by the interactive HTML packer. It does not add CSS `@import`, ES module graph, or runtime network dependency discovery. A newly opened static safe preview reads no related files and observes only the root. Switching interactive HTML to static preview releases dependency watches and retains the root Resource.

## Automatic-refresh controls

Document Preview and Files each retain their existing reload button. The separate automatic-refresh icon control is temporarily hidden; its state, toggle logic, copy, and styles remain. New Tabs still default to `autoRefresh: true`. Hiding the control does not change its state or stop observation.

| State or action | Behavior |
|---|---|
| Automatic refresh enabled | The control is highlighted, uses the existing pause icon, and offers “Disable auto refresh”; changes refresh the corresponding preview or directory node |
| Disable | The control shows the play icon and offers “Enable auto refresh”; observation continues without automatically replacing displayed content |
| Reenable | Refresh once immediately if changes occurred while paused, then resume automatic refresh |
| Original reload button | Read again regardless of automatic-refresh state, without changing that state |
| Expand a new directory while paused | The new directory still loads initially and subscribes; the switch controls only subsequent automatic rereads |

Pause and play use existing icons; manual reload retains its circular arrow. No new icon system is added. The button exposes state through `aria-pressed`, with its name and tooltip in the existing locale dictionaries.

## Complete Files-panel data flow

```text
Files.open
  → FilesBody → Session.cwd + Tab
  → filesFace.start → DirectoryNode.open
  → changes(sessionId, path)
  → Host.watch(depth: 0) → ready
  → DirectoryNode → list(sessionId, path)
  → createFilesStore.levels[path]
  → Level / Entry

Entry.expand
  → filesFace.toggle
  → DirectoryNode.expand → child.open
  → child.watch → ready → child.list
  → createFilesStore.expanded + levels[path]

Process → create / remove / rename
  → Host.change(directory)
  → DirectoryNode.refresh → list(path)
  → createFilesStore.levels[path]
  → DirectoryNode.children ↔ list.entries
  → DirectoryNode.collapse → child.close
```

File previews and the directory tree are independent consumers. A preview can refresh without an open Files panel; Files can update entries without any file preview. Neither a Resource for the whole tree nor a new directory Resource protocol is needed.

The directory panel obtains invalidations and listings through injected Remote callbacks and writes displayed values through its own store. Components retain their existing read interfaces and do not directly hold Chokidar, Remote iterators, or low-level observation objects.

## Directory-node tree and lifecycle

The Files runtime is itself an on-demand directory tree. It does not first construct the whole Workspace tree or separately derive a flat watcher set. Existing `filesFace` owns each Tab's root; `DirectoryNode` owns reads, observation, and release recursively, without another controller class.

| Node responsibility | Behavior |
|---|---|
| Directory identity | Hold this directory's path and Session/Tab ownership; filesystem roots and Windows drive roots are valid roots, and listings contain only direct entries |
| Directory watch | One open node holds one target stream; notifications invalidate only this node's listing |
| Directory read | Retain the active list generation and pending rereads through read completion; publish results through store actions |
| Open children | Hold child `DirectoryNode` objects by direct-child path; unexpanded directories remain listing entries without active nodes |
| Expand | A directory-row action creates or reuses its child, which subscribes and reads; restoration opens only directories still present in the listing |
| Collapse | Remove and close the active child; recursively close its descendants and release its watch and requests |
| Listing update | Retain open children still present; close deleted, renamed, or file-replaced branches without reopening every node |
| Close tree | Closing the root recursively releases the active tree, without traversing another global watcher registry |

`createFilesStore.expanded` retains user expansion preferences, but is not another watcher registry. Closing a parent cannot retain active descendant nodes merely because their preferences remain. Reopening first reads the parent, then progressively restores still-present children. Expand and collapse actions update the store and pending restoration even when the parent node is not yet active; restored descendants follow the latest preferences instead of reopening a collapsed branch.

```text
workspace/                  watch
├── src/          open      watch
│   ├── components/ open    watch
│   └── internal/ closed    -
└── assets/       closed    -

collapse(src/):
workspace/                  watch
├── src/                    close(src/, components/)
└── assets/                 -
```

The parent's watch still detects deletion, renaming, or replacement of a collapsed child, but not changes deep inside it. Listing again on expansion discovers changes made while it was not watched.

| User action or lifecycle event | File preview | Files panel |
|---|---|---|
| First open | Subscribe to the file Resource and read contents | Open the root node, which subscribes and lists |
| Expand child | No effect | The parent opens the child; the child subscribes and reads direct entries, progressively restoring still-present descendants from preferences |
| Collapse child | Open file previews keep their watches | Release that directory and its hidden descendants; expansion preferences and displayed cache may remain |
| Switch Tab or unmount panel | The Tab pin retains file metadata; an unmounted body does not reread, and refreshes on return according to pending Resource changes and toggle state | Retain expanded nodes and watchers for the Tab lifetime; do not introduce another panel-visibility lifetime |
| Manual refresh | Reuse the current preview reload without rebuilding the Resource system | Recursively refresh open children from the root, without entering collapsed directories or rebuilding all watchers |
| Last holder closes | Resource abort ends the file stream; the Host awaits watcher closure | Tab closure ends every directory stream, cancels reads, and forgets Tab state |
| Connection recovers | Stat again after the new stream's ready frame, discovering changes even without event replay | List every still-watched directory after its new stream's ready frame |

Files watches follow Tab lifetimes. Collapse closes the corresponding subtree; Tab closure releases the root and its entire active tree. Temporarily hiding the panel does not rebuild nodes, keeping implementation within the existing entry point and directory objects. The store retains expansion preferences; nodes use them for progressive restoration only when reopened, without a second global expansion set.

`ResourceRegistry` continues sharing identical complete file Resource addresses. Parent-child ownership prevents duplicate active branches inside one Tab. This version adds no global watcher deduplication across Sessions, windows, or path aliases. Ordinary file rows do not each subscribe to file watches; only files opened as preview Resources acquire independent file observation.

## User flows

### Edit a previewed file

1. The user opens Markdown, code, an image, PDF, HTML, or Office file from Files.
2. The user saves it in an external editor or rewrites it through a shell command.
3. Automatic refresh is enabled by default, so Document Preview displays new content. Disabling it retains current content until manual reload or reenabling.
4. Renderer selection and wrapping preferences remain. Text scrolling uses existing restoration; shorter content limits the available position.
5. Exact position restoration for PDF, HTML, and images is not an additional promise. Existing renderer behavior remains, without a cross-format location system for automatic refresh.

### Browse changing directories

1. The user opens Files; the root lists and begins observation.
2. The user expands `src` and `src/components`; both start their own watchers.
3. An external tool creates a file in `src/components`; only that level refreshes, without collapsing or reloading other directories.
4. The user collapses `src`; its own watch and the `components` watch close, while the root remains watched.
5. External changes continue while collapsed. Reopening `src` rereads it and progressively restores valid descendant expansion, rather than remaining on old cached entries.

### Deletion, renaming, and failure

- Deleting a file retains existing preview content with an unavailable notice; recreating its original path while its parent remains resumes reading. Renaming means disappearance at the old path and appearance at a new one, without rewriting the preview address from inode identity.
- Deleting or renaming a directory refreshes its parent, removes the old row, and releases the old subtree. A new directory appears under its new name without transferring old-path expansion preferences.
- Automatic and manual refresh invoke the same existing reload, retaining its clearing, loading, and error presentation. No old-byte or old-iframe retention branch is added. Directory refresh retains the existing listing cache to avoid rebuilding active subtrees.
- When a backend cannot watch, the Host converts initialization failure into a `workspace-file/watch-unsupported` `RemoteError`. The Client ends observation while continuing ordinary reads and manual refresh, without polling. External SSH filesystem changes do not automatically update previews.

## Readiness, races, and refresh coalescing

Observation, reads, and presentation need a few explicit ordering rules, not disk transactions or an operation log.

- Establish the watch before sending ready, then obtain initial stat/list. Do not discard changes arriving during a read; reread when necessary to converge on current state.
- Events mean that a target may have changed, not exact replay of a user operation. Duplicate Chokidar events and consecutive writes may coalesce; files deduplicate versions, and directories coalesce pending refreshes.
- Each directory has at most one active list. Further invalidation during that request or its completion marks a pending reread, which runs afterwards rather than building an arbitrary queue of refresh jobs.
- File refresh reuses read generations and renderer revisions. Consecutive notifications must not let old requests overwrite new content or endlessly reload an already handled version.
- Background directory refresh retains the displayed listing without a display-unused `refreshing` flag. Only a directory without displayable entries enters `loading`, avoiding subtree flicker and repeated watcher reconstruction.
- After collapse, deletion, or Tab closure, late cancelled reads cannot recreate state or restore watchers. Cancellation closes the Host watcher even while the generator is suspended at a yielded frame; stream and plugin teardown await closure.
- Temporary file disappearance while its parent remains does not end observation. Ordinary file changes and watcher failures remain distinct; same-path file watches cover atomic saves and delete/recreate.
- Existing file reads are not transaction snapshots: writes can occur between stat and content reading. Later notifications trigger refresh; automatic refresh does not promise an atomic snapshot for every read.

## Alternatives considered

**Another Resource `onChange` and content reload.** Existing `open()`, `source()`, and `useResource` already express change, while the generic Resource does not own contents. Duplicate interfaces would make metadata, contents, and renderers each manage refresh state.

**Recursive watching of the whole Workspace.** Opening one file or root directory should not watch every deep directory. Watching the current file and expanded directories ties resource use to what the user has actually opened.

**Keep Session broadcasts and add path registration/unregistration.** The Host needs explicit targets, but not another path set maintained through additional commands. One target per stream directly reuses cancellation, reconnect, and ending semantics.

**Push contents or complete listings.** This mixes observation with reads and duplicates pagination, byte limits, formats, and entry caps. Small notifications followed by existing `read()`/`list()` calls are more direct.

**Apply directory-row additions and removals from Client events.** Filesystem events can coalesce or repeat, while listings own sorting, types, and entry limits. Relisting the affected level retains existing semantics without a directory-patch merge algorithm.

**Call Chokidar directly in the Workspace API.** The API does not own the execution world; SSH paths may exist only remotely. The actual FS provider must implement watching.

## Verification

The owning FS, Workspace API, preview, and Files tests exercise watch lifetimes, metadata updates, and automatic refresh. The [Web document-preview test](../../../../apps/web/tests/document-preview.e2e.ts) exercises previews through the shipped Web composition. Session event logs, persistence formats, and model input are unchanged.

| Scenario | Verified behavior |
|---|---|
| External in-place writes, atomic replacement, shell writes | Open previews refresh without depending on `fs/observed` |
| Text, complete bytes, renderer-owned loading | All three modes refresh; old requests cannot overwrite new results, and Office failures allow a later file change to retry |
| First member metadata | Establish a baseline without an extra reload or first-read version reconciliation |
| Only CSS/JS changes, with unchanged HTML root | The group reloads the complete HTML |
| HTML removes a dependency reference | Updating membership releases the unreferenced Resource |
| Disable automatic refresh, modify, then reload or reenable | Content remains while paused and catches up on manual action or reenabling; the controls remain independent |
| Root's direct entries are created, deleted, or renamed | The Files root level updates automatically, including when the workspace is a filesystem or Windows drive root |
| An expanded child changes | Refresh only its level while preserving other levels and expansion preferences |
| Unexpanded deep directories | No deep watcher or recursive traversal |
| Collapse a parent | Release its watch and hidden descendants; an independently open file preview keeps watching |
| Collapse or reexpand a deep descendant during ancestor restoration | Record the latest preference immediately; restoration opens only branches still expanded |
| Reopen, return to Files, or reconnect | Obtain current listings without depending on replay of missed events |
| Delete/recreate a file, or replace a child directory with a file | File watches recover at the same path while the parent remains; directory listings release invalid subtrees |
| Rapid writes, duplicate notifications, changes during reads or their completion | Converge on current state with finite rereads, without endless refresh |
| Close Tab, unload plugin, cancel initialization | Close all owned watches even when no further frame is requested; late notifications and reads no longer write state |
| Unsupported providers or out-of-workspace directories | Report unavailable observation or access errors explicitly, without watching the wrong execution world or widening directory authority |

Controlled streams and deferred reads verify readiness, cancellation, and expansion during restoration. Real local-watch tests use temporary directories, wait for readiness before acting, and finish on observable state rather than fixed sleeps. The Web preview test and owner-local UI tests cover user-visible behavior; executed command results belong in the PR.

## Consequences

- Automatic watch recovery after a parent directory is deleted and recreated on Linux is deferred. Same-path file recreation while the parent remains stays supported.
- OS file events are not durable messages. Disconnects and process restarts may lose notifications, so every stream generation obtains current state after readiness.
- Open files and expanded directories increase watcher and stream counts. The first version controls this through on-demand lifetimes, without an advance cross-consumer deduplication service.
- Automatic refresh may interrupt reading, especially HTML interactions and Office conversion. View preferences and coalescing remain, but arbitrary embedded-document runtime state is not preserved.
- HTML CSS/JS members come from the existing parser. Deeper dependencies, image dependencies, and runtime loading are not additional parsing work in this change.
- SSH OS watching needs its own remote implementation strategy. This interface declares unsupported operation honestly, without local watchers or implicit polling masquerading as remote support.

## Relationship to existing Agent Notes

Automatic refresh and OS watching retain the Resource model, file-read authorization, and renderer ownership. The following records retain independent rationale; this note owns target-scoped observation, automatic reload, and directory-watch lifetimes.

- [Client Resource model](../../implemented/architecture/2026-09-05-client-resource-model.md): retain addresses, providers, subscriptions, and lifetimes; existing streams carry the new behavior.
- [Workspace file service](../../implemented/architecture/2026-09-05-workspace-files-service.md): read and listing responsibilities remain; target-scoped OS observation replaces the Session-scoped operation-only stream.
- [Document preview operations](../../implemented/architecture/2026-09-08-document-preview-operations.md): content-loading ownership and all three modes remain; automatic refresh uses their existing reload paths.
- [Workspace file-read authority](../../implemented/architecture/2026-09-09-workspace-file-read-authority.md): retain distinct access scopes for file reading and directory browsing; target watches follow their respective rules.
- [Sidebar text preview and file tree](../../implemented/feature/2026-09-05-sidebar-text-preview-and-file-tree.md): per-Tab expansion, navigation, and scrolling remain; open nodes own automatic directory invalidation and watching.
