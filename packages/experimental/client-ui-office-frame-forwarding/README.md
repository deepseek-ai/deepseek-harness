---
description: "Open local DOCX, XLSX, and PPTX files in Desktop with native read-only preview and format-specific fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-office-frame-forwarding

English | [中文](README.zh.md)

## Summary

The optional Office read-only preview bundle activates this package when the user enables it in Plugins. Native viewing includes selection, zoom, paging, sheet navigation, and slideshow playback. In read-only mode, dragging from inside an existing selection starts a new range; Shift retains native range extension. Preview reuses the document header for the file path and reload action; PowerPoint playback appears beside reload. Ordinary Web and headless profiles keep their existing behavior.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open a local DOCX, XLSX, or PPTX file in Desktop. Read-only preview uses FrameForwarding, with the shared Web spinner and font, engine, document, and first-frame loading stages. The sidebar owns format routing and renders the fallback: the browser spreadsheet viewer for XLSX/XLS and PDF for Word/PowerPoint. It renders the fallback for other formats or when FrameForwarding is unsupported; when native opening fails, the engine crashes, rendering fails, native frames become unavailable, the video backend fails (including repeated presentation failures without a successful video track write and a rejected slideshow playback), or the engine or channel event stream from the Host ends with an unrecoverable error, this plugin calls the slot owner's `onNativeUnavailable` once and the sidebar switches to the fallback. A lost channel reconnects automatically within its configured limit, including when a slideshow is waiting for its first viewport. Only reaching that limit keeps the Reconnect action. CSV and TSV keep the spreadsheet viewer's own entry. XLSX and XLS have no renderer selector. Selection overlays become visible after the first document frame is submitted to the video track. Media playback can briefly lag behind its coordinates during scrolling or zooming. An open tab automatically reopens an expired document once. If reopening fails, it uses the format fallback. Manual reload or a source change starts a new attempt.

Switching tabs preserves the open document, selection, scroll position, zoom, and static page previews. Hidden mounts send an invisible viewport so the engine trims idle surfaces; returning repaints the current window. Closing the tab or switching to the fallback releases its native session. Unloading the plugin waits for these releases before withdrawing the Office Remote. Reload and source changes open a separate native document, so releasing the previous view cannot close the current preview.

Several documents render at once, for example in floating windows, and each waits only for its own work. When graphics memory is unavailable, a view keeps its last image, fills uncovered content with page previews or its theme-owned underlay, and shows a waiting notice. Texture-credit timeouts retry with capped exponential backoff; after `creditRetryLimit` consecutive timeouts, an acknowledged invisible viewport reclaims idle surfaces before rendering resumes. Pausing or hiding a view clears its waiting notice and retry timer; visible, enabled views resume the latest demand. Frame forwarding must allow at least three frames per channel (`maxFrames >= 3`).

PowerPoint playback shows the document view fullscreen in place as a modal layer, so it covers the screen, including sidebar controls; the play button requests fullscreen before the slideshow starts, and a refused request starts none. Tab stays within the slideshow controls and Escape exits from either the slide or its controls, also when the document leaves fullscreen on Escape itself. Hiding the slideshow's tab leaves fullscreen. While another element is fullscreen, for example another view's slideshow, a covered view sends an invisible viewport, so its engine stops rendering and returns its idle surfaces until fullscreen ends. Exiting returns the same document view to its preview panel on the last displayed slide. Preview drawing resumes only after the native document selects that slide; a failed selection exits fullscreen and switches to PDF.

On touchscreens, drag with one finger to scroll and pinch with two fingers to zoom the document between 25% and 400%. Pinching keeps the document point under the fingers and does not zoom the application. Word also starts a new range when a drag begins in the left indent of a selected line. Mouse dragging selects content; trackpad pinch and the zoom controls remain available.

In read-only Word, PowerPoint, and Excel previews, hold one finger for 450 ms with at most 8 CSS pixels of movement, then drag to select native content. Word and PowerPoint use their native text and object selection; Excel selects cell ranges. Moving before the hold completes scrolls normally. A second finger ends selection and starts pinch zoom; releasing, cancelling, hiding the tab, or the window losing focus releases the native press. Long-press selection suppresses the touchscreen context menu.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

Native previews reuse the shared UI primitives’ zoom controls; Office supplies fit width for Word and fit page for PowerPoint. The package name carries no `experimental` prefix, so the bundle patch and profiles that name it keep their reference when it leaves the experimental group; the experimental classification still governs its dependency isolation and promotion.

The Host `officePreview` service owns document processes and exposes typed Remote operations; each document runs operations in arrival order, while different documents run concurrently. Loading stages and engine events arrive as Remote streams. Each open tab holds a document lease through `retain(documentId, clientId, signal)`, including while hidden. On reattachment the same renderer receives the last slide and whether playback ended. A new renderer stops any active slideshow on that document. Refreshing during slideshow startup or playback stops the show and detaches the old display before releasing its document. The Client registers native preview only when Host availability reports local rendering and retains each Office body until its tab occurrence aborts. Each document mounts one video element in its tab, including when the tab floats, and drives mount visibility explicitly from tab visibility, document fullscreen occlusion, and surface trimming. PowerPoint playback uses the document's standard Fullscreen API (`requestFullscreen`, `exitFullscreen`, and `fullscreenchange`) directly inside the Office view. View coordinates update independently of paint success, including while a channel waits for reconnection. Pointer coordinates and DOM selection scale use that same content view, including centered documents.

Frame forwarding belongs to the [frame-forwarding package](../frame-forwarding/README.md); Office carries no native code. The Host probes capabilities and opens native documents through the shared `officeKit` service (`discoverRuntime()` and `openDocument()`), which owns Kit loading, engine package resolution outside `app.asar`, and the deployment's font and archive settings. Each document owns one channel and passes its producer credential through `attachSurfaceTransport`; `channelConnectTimeoutMs` must be shorter than `operationTimeoutMs`. Office paint requests carry only an acknowledged generation; the Host supplies the correlation identifier required by Kit. The Host maps transient Kit frame failures to structured `office/frame-retry` reasons (`stale` or `credit-timeout`); Client retry decisions do not parse diagnostic text. A slideshow uses a single stream identifier. Its stream controls and resizes belong to its receive channel. Stopping a slideshow or document mount cancels its viewport waits, including producer acknowledgements during credit recovery. A document mount waits for any paint already sent to the engine. Channel replacement detaches the old video immediately and discards its queued controls. When a channel is lost during a slideshow, the Host stops playback and selects the last shown slide in the running engine before reconnecting. Preview and native input resume on that slide. Automatic reconnects remain bounded by `automaticReconnects` and `automaticReconnectWindowMs`; exhausted reconnects show Reconnect, while native unavailability selects the format fallback. `renderBackend` accepts only `ganesh` (default) and `graphite`; Kit must report a GPU backend or opening fails. Engine failure closes its channel; the failed record remains readable through `info` until release, and reattachment closes it and rejects opening.

Static page previews use `officePreview.pagePreview`: the Host queues Kit `render()` with the document's other operations and returns owned straight-alpha RGBA bytes through a unary Remote binary field, independently of frame forwarding. Each pixel edge is at most 4096; both requested and returned bytes must fit `maxPagePreviewBytes`. Closed or failed documents reject the request. For document painting, `generation` is the acknowledged viewport version returned by `setContentWindow`; a stale-viewport rejection leaves the engine usable and the Client retries after the latest viewport is acknowledged, with at least 1 ms of delay even when `zoomSettleMs` is zero. `OfficeViewport.pixelSize / twipSize` expresses the render window's physical-pixel/twip ratio, including render DPR, rather than CSS pixels alone.

The Host sends `overscanViewports` (default 0.5), `reanchorHysteresis` (0.25), `zoomSettleMs` (120), and `creditRetryLimit` (3) to each document view. The first two are fractions from 0 to 1; the delay is nonnegative milliseconds, and the retry limit is a positive integer. The margin is measured in visible viewports on each side; hysteresis reserves a fraction of that margin before reanchoring. The Client owns zoom settling and texture-credit retry scheduling. Desktop presentation errors invalidate the latest render window and repaint it without replacing the mount. `maxDocumentBytes` limits source bytes. `maxPagePreviewBytes` sets the editor output limit and bounds each static preview response and the per-document preview cache. The Client shrinks overscan to satisfy Kit’s 4096-pixel edge limit, then lowers render DPR if the visible area itself exceeds that limit. Scrolling inside the usable margin updates only `setContentView`; reanchoring waits for the preceding paint to settle, awaits `setContentWindow`, and paints its returned generation. Mount-originated viewport changes and stale-viewport replies schedule the latest demand. Page-preview canvases reveal only the submitted video window intersecting the visible area, using content state events rather than per-frame acknowledgements. A frame error from the current slideshow connection exits fullscreen and opens the format fallback. Slideshow entry detaches the document mount and mounts video in a letterboxed rectangle; exit restores document mounting. Sheet and slide changes detach the old mount before creating a new generation. A fitted slide uses its native frame directly. A partial native window or a texture-credit wait requests a static preview of the current slide. Cached previews stay with the document and can display immediately when revisiting a slide.

Each opened document also receives `rendering.operationTimeoutMs` from the existing Host configuration. Client operations use that deadline and a fixed safety cap of 128 pending requests. Initial open uses the Host’s own open deadline before those settings arrive.

The Client parses each session file address and sends explicit `sessionId` and `path` fields when opening a document. The Host resolves that path from the Session workspace and applies its filesystem permissions. `address` identifies the view; it does not select a Host file. The Host binds the Session and resolved file to the address and stable tab `owner`. The separate `revision` field is a nonnegative safe integer. Opening the same revision reattaches its engine. Opening a different revision, including after a renderer restart, closes the previous engine and channel before loading the file again. Other tabs keep their own engines. The Host releases an engine and its channel after `orphanRetentionMs` without a lease (default 60,000 ms), including when the initial open never acquires one. Closing a tab releases its document immediately.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as Office interactions do not add model context or submit agent turns.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Requires Desktop, a local filesystem, the matching LibreOffice Kit, and a usable GPU backend. Format, animation, and clipboard fidelity follow LibreOffice support.
- Native preview hides comment text, markers, and popups.
- Oversized viewports can render at reduced DPR. Native/DOM alignment during scroll, same-size sheet/slide transitions, and platform memory reclamation require real Desktop validation; jsdom mount tests do not establish compositor timing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Desktop acceptance scenario: open Word, select text, float the tab, fit width, dock it back into a narrower sidebar, then terminate its engine. The tab must switch to PDF without remaining blank. Repeat during PowerPoint fullscreen playback and with a hidden tab: fullscreen must exit and the fallback must appear when the tab returns. Excel must switch to the browser spreadsheet viewer. Reload must attempt native rendering again. Also switch between equal-sized sheets/slides while delaying the next frame: the previous part must disappear before the new generation displays, without exposing content behind the view. Verify video in docked views, floating views, and slideshow playback on macOS and Windows.

</details>
