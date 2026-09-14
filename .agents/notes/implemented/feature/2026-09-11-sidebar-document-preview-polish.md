# Agent Note: Sidebar document preview polish

Status: implemented

English | [中文](2026-09-11-sidebar-document-preview-polish.zh.md)

## Problem

The Sidebar document preview accumulated several experience defects (issue #3974). Images rendered at their intrinsic CSS-pixel size, so a wide image overflowed the pane and forced horizontal scrolling. The viewer dropdown always appended the plain-text fallback, so bitmap and PDF files offered a "Plain text" choice whose result is unreadable bytes, and files with one real renderer still showed a control with nothing meaningful to switch to. Binary containers with no renderer at all (video, archives, office documents) fell into the plain-text reader and surfaced a read error instead of a designed empty state. Each renderer carried its own loading copy and position, so opening a file flashed through several differently worded, differently placed indicators. PDF pages sat inside a double inset that shrank every page below the pane's width. Switching sidebar tabs remounted the file tree at scroll top, losing the reader's place.

## Decision

**Image width fit.** The image frame follows the scroller's width with a 12px inset; the image itself carries `max-width: 100%` and an 8px corner radius, so a wider image scales down to the pane's width at its aspect ratio, a smaller image keeps its intrinsic size centred by auto margins, and a taller image scrolls vertically in the shared body. Height fitting was considered and dropped: it needs a fixed-height frame, and mixed portrait cases produced surprising layouts for no user request.

**Binary viewer choices.** `DocumentPreviewDefinition` gains optional `binaryExtensions`, the suffixes among a renderer's `extensions` whose bytes are not readable text; `register` rejects an entry absent from `extensions`. The renderer owns this knowledge: the image body declares `png, jpg, jpeg, gif, webp, bmp, ico` and leaves `svg` out because SVG source is readable XML; the PDF body declares `pdf`. `binaryDocumentPath` in the registry module answers whether any registered definition declares a filename's suffix binary, and the preview owner skips the plain-text fallback for such files. The header renders the viewer menu only when at least two candidates exist; a single candidate shows no viewer control at all.

**Unsupported empty state.** The owner-side list in `document/unviewable.ts` names binary container suffixes (video, audio, archives, office documents, executables, fonts, disk images, design formats) that no renderer claims. The owner consults it only when no implementation matches, so any renderer registration always wins; a matching file shows the path header, the file-type icon, and one `unsupportedFile` line, and never issues a read. An uncertain suffix stays out of the list and keeps the plain-text fallback; a text-claimed file whose bytes fail the reader's checks reports the same copy through `error.notText`.

**Unified loading.** `LoadingIndicator` renders icon-only, carrying its label as `aria-label` with no visible text; every renderer's loading copy is the shared "Reading…". Every wait before content exists — the owner's first read, PDF parsing, HTML packaging, image decoding — centres the spinner in the pane, so opening a file shows one spinner in one position until the body appears. An unrendered PDF page holds its place as a static 3:4 placeholder block on the theme's skeleton token `--dsw-alias-bg-skeleton` with no spinner; the document-open wait stays the owner's centred read spinner rather than the first page's placeholder, because the read spinner precedes the placeholder and a handoff between them visibly jumps positions. Placeholders carry no shimmer animation, whose per-page cost outweighs its value.

**PDF full-bleed and copy.** The PDF body and page insets are removed so pages fill the pane's width edge to edge; the image renderer keeps its own 12px inset. Chinese error and status lines across the preview dictionaries drop trailing full stops.

**Files tree scroll restore.** `ui-sidebar-files` follows the document preview's own pattern: the tree store gains `scrollTop` with a `scrolled` action, the body tracks its scroll offset locally and commits it once, on unmount and only while the owner's signal is live, and a remount restores it in a layout effect. Loaded levels already outlive the body in the store, so the remounted tree lays out at full height before the offset re-lands.

## Alternatives considered

**A boolean `binary` flag per definition.** The image renderer covers both bitmaps and SVG under one registration, so binariness is a property of the suffix, not the renderer.

**Filtering in the preview owner by a hardcoded suffix list for registered renderers.** The owner would duplicate knowledge each renderer already holds, and external renderers could not extend the set; the owner-side list exists only for suffixes no renderer claims.

**A one-item static viewer label.** Rendering the single remaining candidate as a static name puts a control that offers no action in the header; it is noise, so the header renders nothing.

## Consequences

Images never scroll horizontally; the pane's width is the only layout input, so no zoom control was added. Bitmap and PDF tabs show no viewer control; SVG keeps the menu with the plain-text choice; unclaimed binary containers show the empty state without reading. From open to first content every preview shows one centred icon-only spinner, and PDF pages appear as quiet placeholder blocks. The file tree comes back where the reader left it after any tab switch. Registry unit tests pin `binaryDocumentPath` matching and `register`'s rejection of a binary suffix outside `extensions`, toolbar tests pin the fallback/menu/empty-state branches, files-body tests pin scroll capture on unmount and restore across a remount, and the keyless Web document-preview scenario measures the width-fitted SVG against the pane and asserts the viewer control's absence per suffix.
