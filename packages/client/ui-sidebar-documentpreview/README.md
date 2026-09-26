---
description: "Document previews in the right Sidebar: shared file loading and controls, selectable Markdown, code, image, PDF, Office and HTML renderers, and plain-text fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-documentpreview

English | [中文](README.zh.md)

## Summary

Preview files in the right Sidebar and choose among registered renderers. Markdown and code support paged text; PDF, HTML, common images, and spreadsheets receive complete bytes; unknown extensions use plain text. Word and PowerPoint documents convert locally to PDF; spreadsheets open in the browser. The tab provides file status, renderer selection, wrap, and automatic or manual reload. Plugins can add local opening controls to the header and unsupported-preview empty state.

## Table of Contents

- [What it registers](#what-it-registers)
- [Addresses](#addresses)
- [How it reads](#how-it-reads)
- [Excel preview](#excel-preview)
- [Office preview](#office-preview)
- [Navigation](#navigation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with id `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` (this implementation's identity in the tab system, and the key its body registers under), kind `text`, pattern `dsh-resource://file/**`, band `fallback`. `canOpen` accepts only Session addresses, whose paths may be relative or absolute; bare `absolute` addresses are not claimed. A type registered at the `extension` or `builtin` band for a narrower pattern (say `*.png`) takes those addresses; other supported files land here. The whole address is the content identity, so two files with one name in different directories, or one path under two sessions, are two tabs; the decoded basename is the tab title, and the keyed `sidebar.right.pane.tab.title` seat places its extension-specific `FileTypeIcon` before that title.
- **The body** — the keyed `sidebar.right.pane.tab` seat under the type's id. Its fixed header shows the Host's absolute path when available, otherwise the requested path; the shared [`PathLabel`](../ui-primitives/README.md#component-catalog) subdues directories, preserves a clipped path’s trailing characters with a left-edge fade, and exposes the full value on hover. A dropdown appears when multiple supported renderers are available. Plain text is offered only for text-compatible sources; a single renderer shows no viewer control. A known binary container suffix without a registered renderer shows the file-type icon and an unsupported-preview message under the path header, without issuing a read. Two Session-scoped list child slots hand the previewed file to other plugins once its metadata reports a Host path, both with `absolutePath` as the owner prop: `sidebar.right.tab.document.actions` renders after the header's own controls in every state that shows the header, and `sidebar.right.tab.document.unpreviewable` renders in the unsupported empty state and in the empty state of a readable file the preview cannot render (`not-text`, `too-large`), where Retry would otherwise stand; a carrier or unclassified read failure keeps Retry, and a missing or non-regular path offers only its explanation. The shipped occupant of both is [`ui-open-in-app`](../ui-open-in-app/README.md). A wrap toggle appears only when the selected renderer declares `wrap: true`; its glyph describes the mode the click selects, and the per-tab preference starts on. Reload stays in this header, not the Sidebar's tab strip. Automatic refresh defaults to enabled; its separate toggle is hidden, with state, labels, styles, and toggle logic retained. The body reaches every pane edge; each renderer owns its content inset and may own an inner scrollport. This intentionally differs from the Files tab's 2px right-side scrollbar offset: previews keep the full pane width so edge-to-edge HTML and code scrollports end at the pane edge.
- **Shared loading and view state**, session-scoped and bucketed by tab id. The store holds accumulated pages or complete bytes, read and observed versions, pending Resource changes, automatic-refresh state, loading/failure state, renderer choice, scroll offset, wrap, and the answered navigation revision. The ordinary inject face calls Remote readers and writes through declared store actions. Reloads and loading-mode changes retire older requests; the tab's abort signal forgets its state.

Document implementations register metadata with `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })` and a body under the same `id` in the keyed, Session-scoped `sidebar.right.tab.document` child slot. `binaryExtensions` lists suffixes in `extensions` that cannot be read as text and omit the plain-text option. Own both registrations with effects and wait for the child slot through `ctx.slots.inject`. Bodies receive `resourceAddress`, `content`, `wrap`, `scrollportRef`, `addResource`, `setResources`, and the standard `useTabInfo`/`useResource` hooks. Dependency membership belongs to a tab-owned `ResourceGroup`; replacing dependencies always retains the root Resource. An inner scrolling element attaches `scrollportRef`; unmounting restores the shared body as scroll owner. The registry retains all matching alternatives: `extension` (the default) ranks above `builtin`, then longer suffixes rank first, then registration order. The dropdown preserves a selected implementation while it remains available. HTML, SVG, and unmatched extensions retain the plain-text fallback independently of loading mode.

`loading: 'text-pages'` and `'bytes-complete'` use the shared file reader. With `'renderer'`, the selected body mounts before any bytes are read and receives `content: { kind: 'renderer', revision, loaded, failed, reload }`. Its injected face owns content loading, errors, store updates, and cancellation. `loaded(version)` records the displayed source version and ends loading. `failed()` ends loading without recording a successful version, allowing a later file change to retry; reports from replaced revisions are ignored. `reload()` increments the revision, which the body observes to cancel and replace its request. The body also cancels on unmount and tab closure, retains settled content in its declared tab store, and releases that state when the tab ends. [Office previews](#office-preview) use this mode without putting converted bytes or font metadata in the shared file store.

<a id="addresses"></a>
## Addresses

A tab uses the Session address built by `fileAddressFor`, carrying a relative or absolute path. `hostFileOf(address)` takes the Session only from that address, with no external Session argument; neither current nor Tab Session is borrowed. The Host resolves file and related paths through the Session filesystem, whose backend controls read authority. Metadata for the same complete address is shared by every UI, including Global components. The [Workspace Files README](../../api/workspace-files/README.md) owns these rules; renderer selection does not change the navigation address.

After all text pages load, Markdown images use the authenticated `/api/file` route for absolute file paths and paths relative to the source document's directory. Relative images wait for the Host's absolute document path. URL escapes are decoded once; query and fragment suffixes are excluded from the filename. HTTP(S) images retain their authored URLs, and failed image loads show alt text. Local images require an HTTP(S) application base URL; image files are not added to automatic-refresh dependencies.

<a id="how-it-reads"></a>
## How it reads

Coding Tools selects the HTML preview policy in both Web and desktop. The renderer receives `interactivePreview` from plugin assembly. Off uses a DOMPurify-sanitized complete static document in an iframe with no sandbox permissions: CSP blocks scripts, external resources, connections, forms, and nested frames; all `href` and `xlink:href` attributes, refresh directives, and declarative shadow roots are removed before reparsing. Inline styles and data images remain visible, and related files are not read. On uses the scripted Blob preview described below. A mode change unmounts the previous frame and aborts its pending related-file reads. Static preview releases CSS/JS resource subscriptions and keeps the root file watched. Other document formats retain their own policies.

Both HTML modes set the initial iframe name to `dsh-sidebar-html-<tab-id>` for Desktop shortcut routing. This correlation does not grant the preview access to the parent document.

The body reads its record, navigation and lifetime through `useTabInfo().tab`. `useResource<'file'>(tab.contentId)` supplies metadata; ordinary inject callbacks supply content reads:

- The resource snapshot contains only `status`, `value`, and `failure`; `value` is `WorkspaceFileStat` metadata. Content reads do not wait for the first metadata frame once the provider is available. Observation failures take precedence over Preview's change notice; loaded content remains while metadata is unavailable.
- **Text pages** — plain text, Markdown, and code read through an inject callback to `remote.workspaceFiles.read(sessionId, path, { offset }, signal)`. The first mount reads page one; scrolling to the body end or **Load more** requests the next page until `eof`. The owner delivers the accumulated prefix as `{ kind: 'text', text, pages, eof }`, including source offsets and line counts. Markdown and code render that prefix incrementally; they do not render each page as a separate document. A newer-version page past page one restarts from the beginning rather than mixing versions. A failure before any content fills the body with the file-type icon, the explanation, and the recourse the failure names (Retry, the unpreviewable child slot, or nothing); a later failure retains loaded content and adds the retry below it.
- **Complete bytes** — PDF, HTML, common images, and spreadsheets call `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)`. The binary Remote returns `data: Uint8Array<ArrayBuffer>` directly for `{ kind: 'bytes', data }`. The Host's `maxFileBytes` cap rejects oversized files rather than truncating them. PDF and spreadsheet renderers copy retained bytes before Worker transfer, keeping the Preview buffer usable. Bytes stay in transient view state, never persisted layouts or Session JSONL. Loading-mode changes retire previous results.
- **Reload** — manual reload rereads only the current Preview tab through its Remote callbacks, preserving its scroll preference and retiring older requests. Automatic refresh uses the same callbacks after a `ResourceGroup` member changes. Each member's first metadata establishes a baseline without triggering reload or first-read version reconciliation; later changes received during a read remain pending for another refresh. Reads neither refresh shared metadata nor clear another tab's notice.

When Coding Tools is enabled, HTML fills the body edge to edge in a Blob iframe with exactly `sandbox="allow-scripts"`, without `allow-same-origin`; scripts cannot access the parent application's origin or file reader. The renderer loads directly declared relative `.js` classic scripts and `.css` stylesheets through its injected Remote callback, with fixed safety limits of 4 MiB per asset, 32 MiB total, and 64 distinct assets. Host code resolves the related path, and `readBytes` with `baseFile` returns native bytes. The dependency Resource is added after the read returns, using its `absolutePath` or a string `error.details.path` on failure; without a Host path, the Client does not guess one. Inside the renderer, base64 is used only to embed the iframe bootstrap payload in script text. A `<base href>` leaves dependency resolution to the browser, as do HTTPS resources. Local module imports, CSS `url()`/`@import`, and dynamic `fetch` do not use Host file access. Read failures, invalid UTF-8, or exceeded limits fail the preview rather than publishing a partial asset package. Replacing or unmounting the document releases its Blob URL.

PNG, JPEG, GIF, WebP, BMP, ICO, and SVG render through Blob URLs in an `<img>` static-image context, rounded inside a 12px inset. Images default to fit width without enlarging content smaller than the pane; 100% uses the image's intrinsic CSS-pixel width. The shared zoom controls can produce horizontal and vertical scrolling, but do not provide drag-to-pan. Zoom changes retain the same `<img>` and Blob URL, so animated images continue playing. Raster formats can soften above their intrinsic size, while SVG remains on the browser's vector rendering path. SVG markup never enters the application DOM or an iframe, so its scripts cannot execute or reach the parent page. Replacing or unmounting the image revokes its Blob URL.

Shared copy comes from `sidebarDocumentPreview`; each builtin renderer owns its localized labels. PDF and converted Office previews use a cool light-grey background in light mode and a matte-black background in dark mode, with subtle page shadows and original document colors. PDF and image previews share a floating control with **Fit width**, 25%, 50%, 100%, 150%, and 200% choices plus 25% incremental zoom across the 25%–400% fixed range. Fit width is the default and tracks pane resizing; 100% means the PDF's 96-DPI page size or the image's intrinsic CSS-pixel size. On fine pointers, the control starts hidden, slides up when the pointer enters the bottom 72 CSS pixels, and slides down after a 420 ms leave delay; hover, keyboard focus, an open menu, and an active gesture keep it visible, while devices without hover keep it visible continuously. Chromium maps a macOS trackpad pinch to the same live, pointer-anchored path as Ctrl+wheel; the control displays the gesture percentage, and the settled value survives body remounts until the tab closes. HTML previews do not expose zoom controls. After zoom settles or fit width changes, nearby PDF pages redraw at the resolved scale multiplied by the device pixel ratio. The previous bitmap and selectable text stay visible until the replacement bitmap is ready; offscreen pages refresh when they approach the viewport.

Initial reads and renderer preparation, including Office conversion, share a centered 28px ongoing `StateDot` with the visible localized status “Rendering document...”. The status exposes the same accessible name and respects reduced-motion preferences. Additional text pages keep a compact inline spinner while loaded content stays visible. The PDF body loads its package-local `client.pdf.js` chunk only when a PDF preview mounts; PDF.js, its Worker source, and embedded support data stay out of the startup `client.js`. PDF and converted Word/PowerPoint pages form a vertical sequence with 12px page gaps and a 12px outer inset showing the theme-specific document background; fit width reserves this inset, and pages render lazily near the viewport; an unrendered page holds its place as a quiet 3:4 placeholder block. PDF.js’s official TextLayerBuilder manages selection boundaries and normalized copying over an aligned text layer. Its companion styles keep blank line breaks unhighlighted; alignment accounts for PDF page units, page rotation, and viewport resizing, and page disposal cancels both layers. Image-only PDFs contain no selectable text. Code previews show a tertiary-colored language label and a copy icon with a tooltip; wrapping remains in the document toolbar. They show source line numbers by default without including them in copied text; plain text uses the same font size and line height as code. Code sits on the pane's own background rather than the chat card's fill; its banner is adjacent to a full-height inner scrollport, so both scrollbars begin below the copy control.

<a id="excel-preview"></a>
## Excel preview

Open `.xlsx`, `.xls`, `.csv`, and `.tsv` directly in the browser with worksheet tabs, cell selection, copying, and a read-only formula bar. XLSX retains fonts, solid fills, borders, number formats, rich text, merged cells, row and column sizes, hidden rows/columns/sheets, and frozen headings. XLS retains saved values, formulas, number formats, merges, and available row/column metadata; fonts, borders, and frozen panes are unsupported. Workbooks display saved formula results without recalculating; missing results remain blank, and a compact formula-bar warning marks workbooks whose displayed results may be incomplete or inaccurate. The workbook viewport fills the preview pane and follows its size changes without reloading its sheets or selection. Worksheet tabs start at the left edge; overflowing tabs scroll with horizontal trackpad gestures or left/right navigation beside a separate zoom control. Spreadsheet controls retain dark text on their light background in both app themes. Pixel-based trackpad gestures pan the grid on both axes together, including diagonally, at the gesture’s speed; frozen headings stay fixed. Reversing direction at a sheet edge retains the next gesture’s movement. Selection statistics and inactive worksheet menu arrows are hidden. Frozen headings remain fixed while scrolling, without freeze dividers or drag handles. Spreadsheet preview does not call the Office conversion service.

XLSX preview omits DrawingML parts from an in-memory copy before parsing and ignores worksheet drawing references. The original file and worksheet XML remain unchanged. A notice above the table lists detected charts, images, shapes, and conditional formatting that are not displayed, and recommends opening the workbook in a system application. Files without these detected features have no notice; formula warnings remain separate.

CSV and TSV default to the spreadsheet viewer and also offer Plain text; CSV additionally offers syntax-highlighted Code. Commas and tabs delimit their fields respectively; quoted separators, escaped quotes, multiline fields, empty fields, and unequal row lengths are supported. The first row remains data. Values remain literal strings, including leading zeros, dates, booleans, and formula-looking text. Text files accept UTF-8 or BOM-marked UTF-16; invalid encoding receives conversion guidance. Malformed quoted fields fail the table preview rather than silently dropping data.

Configure `excel` on the same `ui-sidebar-documentpreview` entry. These limits complement the Host's complete-file read limit; they do not cap browser process memory or decompression allocations.

| Field | Default | Meaning |
|---|---|---|
| `excel.maxBytes` | `16777216` (16 MiB) | Maximum source file bytes |
| `excel.maxCells` | `250000` | Maximum combined rectangular worksheet area, including empty cells |
| `excel.timeoutMs` | `15000` | Maximum parser Worker lifetime in milliseconds |

The lazy Excel chunk bundles FortuneSheet, ExcelJS for XLSX, SheetJS CE for XLS, and PapaParse for CSV/TSV. Package-local, React-independent adapters map parser output directly to FortuneSheet cells and share cell formatting and initial selection. Third-party license texts remain in the published chunk; SheetJS CE retains its Apache-2.0 terms. Each parse owns a disposable Worker and transfers a copy of retained file bytes; replacement, unmount, failure, and timeout terminate that Worker. The stylesheet is scoped to the Excel preview. Charts, drawings/images, pivot tables, conditional formatting, editing, recalculation, and export are unsupported; font availability, Excel column-width approximation, and theme-tint approximation can affect fidelity. Hyperlinks display as text without loading their targets. ExcelJS decodes entity spellings in cached XLSX string formula results again; a saved literal `&lt;` is displayed as `<`.

The read-only formula bar displays formulas and cell text literally on one line, with horizontal scrolling for long content. Copying preserves an HTML table with escaped cell contents, including saved formula results. The [FortuneSheet patch rationale](../../../.agents/notes/implemented/feature/2026-09-16-browser-excel-preview.md) explains the requirements for retaining these behaviors and worksheet selection when upgrading the dependency.

The pinned [ExcelJS patch](../../../patches/exceljs@4.4.0.patch) resolves the workbook, styles, shared strings, worksheets, comments, Tables, and VML through package relationships, including absolute and relative targets and ASCII case-equivalent part names, and recognizes SpreadsheetML and VML names by namespace URI. Strict OOXML SpreadsheetML and relationship URIs map to the same supported preview features; this is not full Strict conformance. XML parts accept UTF-8 and either byte order of UTF-16; CDATA contributes literal text. Drawing and conditional-format notices follow relationships regardless of part directories. Unreferenced `xl/drawings/*.xml` parts and their relationship files are also omitted, without adding notices; comment VML remains. Missing referenced parts and ambiguous case-equivalent ZIP entries fail the preview. Comments and Table metadata survive parsing but have no dedicated preview controls. The patch covers the Node sources and `dist/exceljs.js`; its browser entry selects that patched bundle. Dependency upgrades must preserve both entry paths and pass the [independent-writer regressions and fuzz diagnostics](tests/fuzz/README.md).

<a id="office-preview"></a>
## Office preview

Open `.doc`, `.docx`, `.ppt`, and `.pptx` as PDF previews with the same loading state, zoom controls, cancellation, and selectable text as PDF files. The [Host provider](../../document/office-to-pdf/README.md) performs local conversion and retains its spreadsheet conversion API for other consumers. Invalid supported files, conversion failures, and timeouts receive localized messages. Missing Host services show configuration guidance.

The [Web bundle](../../bundle/web-app/README.md) mounts this package as `ui-sidebar-documentpreview`. Configure its transient Office cache through that entry's `office` settings; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-ui-sidebar-documentpreview) defines accepted values. Settings are embedded in each served page; reload the browser page after changing YAML.

| Field | Default | Meaning |
|---|---|---|
| `office.maxCachedEntries` | `8` | Maximum retained completed PDFs |
| `office.maxCachedBytes` | `67108864` (64 MiB) | Maximum retained binary PDF bytes, counted by buffer `byteLength` |
| `office.maxPending` / `office.maxReaders` | `8` / `32` | Unsettled conversion RPCs / readers including metadata lookups |

Opening an Office file requests conversion on demand. Each read checks renderer generation and authorized source metadata before sharing an in-flight conversion or reusing a successful PDF. The cache uses renderer generation, Session, absolute source path, and source version as its identity; least-recently used PDFs leave to keep retention within both limits. Failures and PDFs larger than the byte limit are not retained. A converted PDF is retained only when its returned renderer generation matches the cache identity. Cancelling one reader leaves shared conversion running until the final reader leaves. Connection resets clear cached bytes and cancel pending reads; plugin disposal also waits for outstanding requests. PDFs are never persisted; transport strings, decoding storage, and PDF.js rendering memory remain outside the cache limit.

Background requests leave the final pending-request and reader slots available for foreground work; setting either limit to one rejects background reads. Renderer replacement restarts generation discovery and authorization once. Another replacement during that retry reports the localized busy message.

A yellow rounded-triangle warning appears before Reload in the document toolbar when the current Office preview has missing fonts. Hover or keyboard focus shows the missing-font count; clicking opens an anchored list. Escape, Close, or clicking outside closes the list without hiding the warning or moving the document. Reloading closes the old details; previews with no missing fonts show no warning. Viewed and dismissed states are not retained.

<details>
<summary>Office implementation — click to expand</summary>

Office registration, loading, caching, and font notices live in `src/client/office/`. The injected Office face writes converted PDF bytes, font metadata, and failures through the declared store actions. The Office body triggers loading, binds cancellation to its lifecycle, and declares a nested PDF slot that reuses the lazy PDF body and its tab viewing state. The keyed `sidebar.right.tab.document.action` slot places renderer controls before Reload. The Office action shares the body’s store and reads only the current revision’s font metadata. Registration remains available without the Host renderer; optional `remote.officeToPdf` and `remote.workspaceFiles` injections supply conversion and freshness callbacks, and their removal restores unavailable guidance. Registrations and tab retention follow effect lifetimes. The [conversion service](../../document/office-to-pdf/README.md) owns the Host Remote methods, mounted by `api/remotes`.

The Office Remote returns converted PDFs as native `Uint8Array` values through Connection's multipart binary transport. Renderers borrow retained bytes read-only and copy them before Worker transfer.

The page refresh shortcut reuses the selected preview’s reload operation, including its request retirement and scroll retention. The header reload tooltip and ARIA combination follow the effective shortcut binding.

</details>

<a id="navigation"></a>
## Navigation

`ctx.sidebarRight.openResource(address, { params: { line } })` carries a 1-based source line through the `file` parameters. In `text-pages` mode, the owner loads sequential pages until that line or EOF. Plain-text and code renderers expose source-line anchors; Markdown does not. A navigation remains pending while its selected renderer has no anchor and runs if the user switches to plain text or code. Code navigation scrolls the inner source viewport directly. Byte-mode renderers do not consume source-line navigation. Each completed navigation revision is answered once. Opening the same file without `revealIfOpened: false` focuses its existing tab and delivers a new revision.

<a id="model-experience"></a>
## Model Experience

None, as the preview is a browser-only viewer that registers no tool, prompt section, or session event.

#### KV Cache effect

No direct effect; what the user reads here never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Preview, not editing.** The viewers provide no file editing or shared search interface; a directory address fails with `not-regular-file`. Unknown extensions use the plain-text reader and remain subject to its UTF-8/NUL checks.
- **Office conversion limits.** The preview does not launch native Office editors or download an engine. Binary `.doc` and `.ppt` files return no missing-font diagnostics. Conversion fidelity and resource limits belong to the [LibreOffice provider](../../document/office-to-pdf/README.md).
- **Sequential text and bounded complete files.** Deep source lines require the preceding pages; PDF, HTML, and images require a complete result within the Host's `maxFileBytes` cap.
- **PDF raster allocation is bounded.** Each page bitmap is capped at 16,777,216 pixels; very large pages or high zoom on high-density displays can still render below device resolution.
- **Byte-view scroll state is not restored.** PDF, HTML, and images can return to the top when their renderer remounts or reloads; fixed PDF and image zoom can overflow horizontally, and HTML iframe scrolling belongs to its opaque browsing context.
- **Finite local HTML dependencies.** Only direct classic `.js` and stylesheet `.css` references are packed. Browser-resolved resources retain browser origin and network restrictions; no runtime file-read bridge is exposed to the iframe.
- **Scroll writes are unthrottled.** Every scroll event records its offset in the store; the line blocks are memoized so the resulting re-render hands React the same elements back.
- **A failed PDF chunk load requires a page reload.** React caches a rejected lazy import for the page lifetime; ordinary PDF open or render failures remain retryable inside the loaded body.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Renderer metadata, document loading, and view state belong to the local registry and declared Slot stores, with no independent runtime source to compare against; registration disposal and tab lifetimes are covered by behavior tests.
