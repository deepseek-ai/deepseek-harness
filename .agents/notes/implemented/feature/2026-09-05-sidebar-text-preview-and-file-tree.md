# Agent Note: Sidebar text preview and file tree

Status: implemented

English | [中文](2026-09-05-sidebar-text-preview-and-file-tree.zh.md)

## Problem

The right Sidebar's [docking infrastructure](2026-09-04-right-sidebar-docking-infrastructure.md) and its [tab type registry](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) give a plugin a place to register a tab type, but a surface with no types is an empty column. Three questions had to be answered by shipped code before anyone else could register a type: what a new pane shows before it holds content, how a file the agent produced or read is looked at without leaving the product, and how a reader finds a file the conversation never mentioned. The answers also had to demonstrate the type authoring model end to end — a static definition, a body in a keyed seat, a Slot store and inject face for the type's own state, `useResource` for live data behind an address — so that a type written outside `ui-sidebar-right` has a worked template rather than a contract alone.

Each answer carries product rules that code alone does not explain: why a text file loads by page instead of whole, why a changed file is announced rather than refreshed, why the file tree is a page type that claims no address, why the guide gives its tab away instead of opening beside itself. This note records those decisions for the three shipped types.

## Decision

Three tab types ship with the Sidebar: the **guide** (`ui-sidebar-right`), the **document preview** (`ui-sidebar-documentpreview`), and the **file tree** (`ui-sidebar-files`). Each registers a static definition into `ctx.sidebarRightTabs` and a body into the keyed `sidebar.right.pane.tab` seat under the definition's `id`, inside its own `ctx.effect`, so the type exists exactly as long as its plugin. The guide and the tree are page types opened by kind; the document preview is a viewer that claims Session-scoped `file` resource addresses at the lowest band. A type's controls live in its own body; the pane's tab strip carries only the panel's actions. Copy is locale-owned in each package's namespace (`sidebarRight`, `sidebarDocumentPreview`, `sidebarFiles`).

### The guide

[Default pages and close protection](2026-09-08-sidebar-default-pages.md) supersedes this section's default-guide selection; guide registration, replacement and uniqueness remain unchanged.

The guide is what a pane shows before it holds content. Its registration is `{ id: '@deepseek-ai/dsh-client-ui-sidebar-right/guide', kind: 'guide', priority: 'builtin', title }` with no `patterns`: a guide views nothing, so it is opened by kind through `openTab` and recorded under the page address `sidebar://guide`, which is the registry's bookkeeping and never composed by a caller. The tab's title is `开始` / `Start`, captured into the layout record when the pane is seeded, so a later language change relabels the type and not tabs already open.

The body projects every registered type's `guide[]` in `order` through the registry's observable `guide()` list, so a type registering later appears without the guide knowing it. [Guide start page and stat pill refinements](2026-09-10-guide-start-page-and-stat-pill-refinements.md) owns the compass, optional descriptions, fallback glyph, and current capsule layout. Picking a capsule calls `tabActions.openTab(entry.kind, { replaceTab: true })`: the picked type opens in the guide's own tab, and the guide is gone. The guide is a doorway, not a page that stays open beside what it opened.

The body is also the replacement seam. It renders the `sidebar.right.tab.guide` chain with the shipped guide as the chain's fallback, so a product that registers its own entry takes the whole body, and with no entry, or every entry declining, the shipped guide draws. Because the shipped guide is the fallback and not a chain entry, there is always exactly one body and it cannot be outvoted by accident.

A pane holds at most one guide, and the docking layer enforces it as product behaviour: the strip's add control hides while a guide is present, opening the guide into such a pane focuses it, a guide is never duplicated, and a guide dragged, dropped, or docked into a pane that already has one merges into it (the arriving tab closes). An expanded empty root receives the current default page. Collapsed layouts may remain empty until expansion, when the default-page selection runs.

### The text preview

The [Document Preview decision](../architecture/2026-09-08-document-preview-operations.md) supersedes this section's renderer, loading, and resource-observation details. The fallback tab registration, paged source navigation, and body-owned controls remain in force.

`text` is the fallback viewer for Session-scoped files. Its registration is `{ id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', kind: 'text', patterns: ['dsh-resource://file/**'], priority: 'fallback', canOpen, title: basenameOf }`. `canOpen` accepts only addresses whose parsed scope is `session`. The pattern contains `:` and so matches the whole address; `fallback` is the lowest band, so a type at `extension` or `builtin` with a narrower pattern (`*.png`, say) takes those addresses and everything else lands here, while the text type stays in the candidate list for any file. The `id` is the package name and doubles as the `key` of the body seat, so an extension that takes the `text` kind over cannot make the seat pick up this body by mistake. The title is the address's decoded last segment: the whole address stays the content identity — two files with one name in different directories, or one path under two sessions, are two tabs — and only the chip text is shortened.

A tab uses `dsh-resource://file/session/<sessionId>/<path>`, where the path may be relative or absolute ([Workspace Files](../architecture/2026-09-05-workspace-files-service.md) owns the grammar and the `fileAddressFor` / `parseFileAddress` helpers). `hostFileOf` accepts only this Session scope and takes both Session and path from the address; a Session-less `absolute` address is not claimed. A malformed claimed address throws as a programming error.

Metadata and content come from different places. `useResource<'file'>(tab.contentId)`, the global standard hook from the [client resource model](../architecture/2026-09-05-client-resource-model.md), yields `WorkspaceFileStat`; the body compares that observed version with the version of its loaded content. The Preview face reads text through `remote.workspaceFiles.read` and complete bytes through `readAll`. A later text page from a newer version restarts from page one, and a retired request cannot write after reload or tab disposal. The [Document Preview decision](../architecture/2026-09-08-document-preview-operations.md) owns renderer-specific loading.

The store is Slot-standard: one exclusive instance per session, bucketed by tab id, holding `{ version, pages, eof, loading, failure, scrollTop, wrap, revision }`. Bucketing by tab, not by file, is deliberate — two tabs of one file scroll independently. The face (`loadPage`, `reloadPages`) is the only asynchronous half: it marks a read in flight, awaits the Remote result, and writes a page or a failure through the store's actions, writing nothing if the owner's `signal` has fired. The `signal` also ends the bucket: the face arms one abort listener per tab at the tab's first read, and that listener forgets the bucket — not the body, which mounts and unmounts as tabs switch; a tab that never read has no bucket and no listener, and a record can end while its body is unmounted behind another tab. Scroll offset, wrap, and the navigation already answered therefore outlive the body: a tab comes back where the reader left it rather than re-reading or jumping again. Nothing persists across a page reload.

Navigation is a `line`. The `read` tool row passes its 1-based `offset` as `openResource(address, { params: { line } })`, and the produced-file chip passes nothing; the body narrows `navigation.params` to `SidebarRightResourceParamsMap['file']` (`{ line?: number }`, declared by the `file` type's owner) without runtime validation, because caller and body meet at a typed same-process boundary. If the loaded pages do not reach the line, the body reads the next page, again, until they do or the file ends — pages load in order; there is no seek — then scrolls the line to the top of the body and highlights it, once per `navigation.revision`. The store records the answered revision, so a body remounting for the same revision restores the scroll offset instead of jumping, and a new `openResource` for the same file (revealed, not duplicated) arrives as a new revision and jumps again. A line past the end of the file stops silently at `eof`; a page that fails while walking stops the walk and shows the failure line.

A changed file is announced, not applied. The body compares the loaded version and the observation captured at read start with later `WorkspaceFileStat.version`; a difference shows the change bar. Reload rereads only this tab through the Preview face and does not mutate shared resource metadata or another tab. A resource failure takes the same bar's place above any content already loaded.

The body's header is one row: the full file path on the left and the matching-renderer menu, conditional wrap toggle, and reload button on the right. The [Document Preview README](../../../../packages/client/ui-sidebar-documentpreview/README.md) owns the current controls, renderer behavior, and scrolling. The preview takes the pane body's full height.

A failed read keeps content already shown and adds a localized failure with a retry action. The Preview names actionable file failures and falls back to the carrier message for other codes; `outside-workspace` belongs to directory listing and is not a Preview-specific failure.

### The file tree

`files` is a page type, not a viewer: it claims no address. Its registration is `{ kind: 'files', id: '@deepseek-ai/dsh-client-ui-sidebar-files', priority: 'builtin', title, guide: [{ order: 10, title, description, icon: FolderSheetGlyph }] }` — no `patterns`, because nothing navigates *to* a file tree by address; the guide's entry box opens the type itself. `FolderSheetGlyph` adapts the shared coloured folder sheet to the guide's requested glyph size; the [guide refinement](2026-09-10-guide-start-page-and-stat-pill-refinements.md) owns that presentation choice. `id` is the implementation's identity in the Tab system and doubles as the `key` of the body seat `sidebar.right.pane.tab`, so the same string names the type and the component that draws it. `register()` returns a disposer and goes through `ctx.effect`, as every registration does.

The root is the session's working directory as the Host reports it in the session list (`useSessions().byId[sessionId].cwd`), labelled by `workspaceTitleOf` from `dsh-util-workspace-path` — the final non-empty path segment — with the root string itself as the label when the path is separator-only. A session without a working directory shows one line (`noWorkspace`) and issues no request. There is no root chooser and no way to browse upward: the Host's `list` refuses paths outside the Session's workspace root, so the one directory the client can list is the one it shows.

The tree is not one resource, and that decides where its state lives. A directory listing per level, expanded lazily, is view state the type owns, so it sits in a Slot-standard exclusive store (one instance per session) bucketed by tab id: `{ root, levels, expanded }`, with `levels` keyed by absolute path to `loading | ready | failed` and `expanded` the absolute paths currently open, root included. A resource has one address and one current value; a tree that pins a resource per expanded level would make the resource model carry which directories a reader has opened, which is the type's business. `useResource` stays for content with a single address.

The face is the tree's only asynchronous half. `start(tabId, root, signal)` seeds the bucket with the root expanded and lists it; `toggle(tabId, path, loaded, signal)` flips the expanded set and lists the level only the first time; `load(tabId, path, signal)` marks `loading`, calls `remote.workspaceFiles.list(sessionId, absolutePath, signal)`, and writes `ready` or `failed`. The adapter keeps the listing's `entries` and `truncated` and drops its workspace-relative `path`: every key in the tree is absolute, and a child's key is its parent joined with the entry name by `/`. Collapsing keeps the level, so reopening draws from memory without a request; a level that failed is likewise kept and not retried on reopen — reload is the retry. The owner's `signal` ends a bucket: on abort the tab is forgotten and a listing that settles afterwards writes nothing, and a mounted body never re-seeds a bucket whose signal has fired.

Rows are the reader's order, not the endpoint's: directories first, then files and other entries, each group by `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })` so `file2` precedes `file10` and case does not split the list. Dotfiles are shown like any other name; the tree filters nothing the Host returned. The three entry types draw differently: `directory` is a button with `aria-expanded` and an open/closed folder glyph whose children indent by 14px per level; `file` is a button with the document glyph and no size column; `other` (a symlink, socket, or device) is a greyed, non-focusable span with `aria-disabled` and a tooltip saying it cannot be opened, so a directory is reported whole without offering a click that would fail. A level the Host cut at its `maxEntries` cap ends with a `truncated` marker after the entries; an empty level says `empty`; a listing in flight shows `loading` under its directory.

A file click is `tabActions.openResource(fileAddressFor(sessionId, root, absolutePath))`: the entry's absolute path under the tree's root becomes the `dsh-resource://file/session/<sessionId>/<path relative to the root>` address, each segment percent-encoded. The tree never names a viewer: the registry's claim decides who draws the address (`text` today, at `fallback`), and an extension that claims `dsh-resource://file/**` above it takes the click without the tree changing. The open lands in the pane holding the files tab at call time, and an already-open tab for the same address is revealed rather than duplicated — both the navigation controller's defaults. The user's call was explicit: a file opened from the tree does not force a split; it takes a new tab where the tree is.

Reload is the tree's one control, an icon button (`reload`) at the right of the root's header row. It resets every level and lists again exactly the paths in `expanded`; a level that was listed and then collapsed is dropped and fetched anew the next time it opens. The control lives in the body because a type's controls belong to its body: the pane's tab strip carries only the kit's and the panel's actions, and no per-type tools seat exists. The tree does not watch the filesystem; a level changes only when reloaded or first expanded, and the `changes` stream is the text viewer's concern.

Copy is the `sidebarFiles` namespace, thirteen keys. Row states: `loading` 「正在读取…」/ "Reading…", `empty` 「空目录」/ "Empty directory", `truncated` 「条目太多，只显示了一部分。」/ "Too many entries; showing only some of them.", `noWorkspace` 「这个会话没有工作区目录。」/ "This session has no workspace directory.", `entry.other` 「这不是文件或目录，没法打开。」/ "Not a file or a directory, so it cannot be opened.", `reload` 「重新读取」/ "Reload". Failure lines are one per Host code, in terms of the directory: `workspace-file/not-found` 「这个目录不在了。可能已被移动或删除。」/ "That directory is gone. It may have been moved or deleted.", `workspace-file/outside-workspace` 「这个目录在工作区之外，侧栏不会读取它。」/ "That directory is outside the workspace, so the sidebar will not read it.", `workspace-file/not-directory` 「这不是一个目录。」/ "That is not a directory."; any other failure, carrier or unclassified, shows `error.unavailable` 「读取失败：{message}」/ "Read failed: {message}" with the failure's own message, because the tree has nothing useful to add to a transport-level error.

## Alternatives considered

**A per-pane tools seat for the active tab's controls (`sidebar.right.pane.tab.tools`).** Shipped for one review round for the text preview's wrap and reload and the tree's reload, then removed on the user's call: it put type-private buttons on the panel's strip beside the split and collapse controls, where they read as panel chrome. A type's controls belong in its own body; the preview's sit at the right end of its path row and the tree's at the right end of its root row.

**Keep `Show in folder`.** A directory has no destination in the Sidebar, and the product decision was no secondary entry to the desktop opener. Removed, with the capability loss stated: `openFile('.')` names a directory, which the text preview refuses with `not-regular-file`, so the row offers nothing rather than a button that always fails.

**Content in the resource stream.** Content can be arbitrarily large, so the `file` resource carries metadata (`version`, `bytes`, `changed`) and the preview reads content by page through `workspaceFiles.read`; the `changed` flag is a notice, not a payload.

**Reload re-fetches every page that was loaded.** The alternative to the shipped rule (drop every page, read the first one again). Not taken: re-fetching the loaded range means several sequential reads before anything can be shown, and the loaded range after an agent edit no longer describes the same lines; the reader keeps their scroll offset and asks for more where the loaded text ends. The reader's place can land in empty space when the earlier view was deep in the file, which is stated as a consequence.

**Refresh the text under the reader when the file changes.** Rejected: reloading under a reader loses their place, and a file the agent is writing changes repeatedly. The bar waits for a click.

**Whole-file read, or seekable pages.** A whole-file read has no bound; seekable pages need a line index the Host does not keep. Pages load in order from the first, and a navigation to a deep line walks pages until it is covered — the cost is stated under Consequences and the seek is deferred.

**Validate `line` at run time.** The first form accepted `unknown` params and treated anything but a positive integer as no request. Rejected once `params` became typed: the `file` type's owner declares `{ line?: number }` in `SidebarRightResourceParamsMap`, caller and body meet at a typed same-process boundary, and the repository rule is not to add runtime validation there.

**The read's session from the slot for every address.** The first form read under the session the body was mounted for. Kept only for the `absolute` scope, which names no session: a `session` address carries its session precisely so that one relative path in two sessions means two files.

**Wrap off by default.** The first form. Reversed on the user's review: a preview column is narrow, and long lines scrolling horizontally hide the text; wrap is on until the reader turns it off, per tab.

**Fill the pane by changing the docking kit's `.paneBody`.** The pane body is a block scroller with a definite height, not a flex container, so the preview's `flex: 1` did nothing and the pane body scrolled a 30,000px-tall preview. Rejected in favour of `height: 100%` on the preview root: the fix is the type's, the kit stays unaware of its bodies, and the file body becomes the one scroller so the header stays put and line jumps scroll the right element.

**Key the store by file, not by tab.** Rejected: two tabs of one file are two reading positions; the pages could be shared but the view could not, and the saving is one page read.

**A package-local `file:///` address builder, and a package-local basename for the tree's root label.** Rejected: a file address must carry its scope — the session whose root resolves a relative path, or the absolute path itself — hence the shared `fileAddressFor`; one `workspaceTitleOf` serves every workspace-label surface.

**Model the whole tree as one resource.** Rejected: a resource has one address and one current value, and a tree that pins a resource per expanded level would make the resource model carry which directories a reader has opened, which is the type's business.

**The guide as a chain entry rather than the chain's fallback.** Rejected: with the shipped guide as an entry, a product's replacement and the shipped guide would both be candidates and the winner would depend on registration order; as the fallback there is always exactly one body and it cannot be outvoted by accident.

**The guide opens the picked type beside itself.** Rejected: the guide is a doorway, and a pane holding the guide plus what it opened would show a doorway that leads nowhere further; `openTab(kind, { replaceTab: true })` hands the tab over.

## Consequences

- A type written outside `ui-sidebar-right` has a complete template: `ui-sidebar-documentpreview` shows a viewer with an address-derived read, an exclusive Slot store bucketed by tab, an inject face, typed navigation params, and body-owned controls; `ui-sidebar-files` shows a page type with a guide entry and a lazily filled store; the guide shows a chain fallback.
- Reading by page bounds every request (`maxLines` lines, `maxBytes` bytes) at the cost of a **Load more** control, no total line count, and sequential walks to a deep line; a navigation to line 40,000 of a large file reads eight pages first.
- Announcing a change instead of applying it keeps the reader's place during an agent's repeated writes, at the cost of showing stale text until the reader clicks; an external edit is never announced.
- Reload reads the first page only, so a reader deep in a file reloads into the top of it and pages forward again; the scroll offset is preserved but may point past the loaded text.
- Per-tab view state survives tab switches and remounts and is gone with the tab or the page; nothing is persisted.
- The file tree renders whatever the Host lists, so a large directory shows up to `maxEntries` rows plus a marker with no search or filter, and a reader finds a deep file by expanding levels one at a time.
- Every user-facing string of the three types is locale-owned and listed in this note, so a copy review has one place to read them.

## Testing

The text preview's `tests/` cover the registry claim and yielding (through the real `SidebarRightTabRegistry`), the address translation (`sessionFileOf` accepting the `session` scope and throwing on others), the store's page, version, reset, view, and forget actions, the face's in-flight, failure, aborted, and reload paths, the page arithmetic (`linesOf`, `offsetsOf`, `lastLineLoaded`), the body's first read, load-more, retry, change bar, navigation walk, jump-once, remount, wrap default and toggle, header controls, and forget-on-abort, the failure-line mapping, and the plugin's registrations and their removal on dispose. A Chromium probe against the built app recorded the fill and scroll numbers (`.artifacts/sidebar-tab-types/app-probe.log`, `ROUND3`): a short file's preview is the pane body's content height, a long file scrolls inside the preview body, and the pane body never scrolls. The file tree's `tests/` cover ordering, lazy loading, collapse memory, reload, the three entry types, truncation and failure rows, and forget-on-abort. `apps/web/tests/sidebar-right.e2e.ts` opens a produced file from the conversation into the preview over the real Remote carrier. `apps/web/tests/document-preview.e2e.ts` covers centred intrinsic-size images, two-axis image scrolling, and inert SVG scripts.

## Deferred

- Virtualized or seekable page loading (pages load in order), a reload that restores the loaded range, throttled scroll persistence, and a wrap icon in `ui-primitives`.
- Search, a total line count, and an end-of-file marker.
- Search, an artifact filter, drag-and-drop, rename, a context menu, current-file highlight, filesystem watching, and browsing above the workspace root in the file tree.
- Product review of the guide's copy, and the guide's behaviour when a type contributes several entries.

## Related

- [Right Sidebar docking infrastructure](2026-09-04-right-sidebar-docking-infrastructure.md) — the panel, panes, and the guide's one-per-pane rule.
- [Sidebar tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) — the registry, bands, `id`, `openTab` / `openResource`, and owner props these types consume.
- [Client resource model](../architecture/2026-09-05-client-resource-model.md) — `useResource` and the `file` protocol's metadata.
- [Workspace Files service](../architecture/2026-09-05-workspace-files-service.md) — the address grammar, `stat` / `read` / `list` / `changes`, and the error codes the failure lines map.
