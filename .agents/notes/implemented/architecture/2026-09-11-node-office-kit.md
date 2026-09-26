# Agent Note: Node Office conversion with independently packaged engines

Status: implemented

English | [中文](2026-09-11-node-office-kit.zh.md)

## Problem

Binary Office and OOXML files require document layout before they can be previewed. Conversion must stay on the device without opening an Office application or adding source bytes to a model conversation. Native engines need platform-specific distribution, while browser conversion duplicates font transport, worker ownership, and resource limits across the Host and Client.

## Decision

The [office-to-pdf capability](../../../../packages/document/README.md) delegates conversion to the independently released `@deepseek-ai/libreoffice-kit` Node API. The [kit ownership decision](2026-09-14-independent-libreoffice-kit.md) owns source maintenance, compatibility versions, and npm distribution. DSH owns Session file authorization, conversion concurrency, private scratch files, output limits, and Remote transport. The [Web bundle](../../../../packages/bundle/web-app/README.md) declares the conversion service and shared Document Preview entry with stable IDs. The service owns authorized conversion Remote methods, whose descriptor is mounted by `api/remotes`; Office UI shares the Document Preview Loader lifetime.

The [platform engine decision](2026-09-15-platform-office-engines.md) requires the kit’s declared native target engine, or WASM when no native target is declared. Missing or invalid required engines reject conversion. The shared [bounded provider](2026-09-15-bounded-office-conversion.md) owns admission, conversion reuse, and cancellation through scratch cleanup. Preview consumes that provider without registering another converter or requiring Office authoring skills.

The service and Remote methods accept DOC, DOCX, XLS, XLSX, PPT, and PPTX. Client PDF previews use this path for Word and PowerPoint; [browser spreadsheet preview](../feature/2026-09-16-browser-excel-preview.md) reads XLSX, XLS, CSV, and TSV independently. The kit verifies bounded ZIP membership and content types for OOXML inputs and the OLE compound-file header for binary Office inputs before LibreOffice imports them. Renaming text to an Office suffix does not admit it. Binary formats return no missing-font diagnostics because the kit does not extract their font tables. It writes a fresh, exclusively created PDF in a caller-owned private directory. DSH reads and validates the complete output before removing scratch files. The [service’s Remote method](../../../../packages/document/office-to-pdf/README.md) authorizes source access through [Workspace Files](2026-09-09-workspace-file-read-authority.md), preserves the source path/version, and returns PDF bytes. Source read caps and generated PDF caps remain independent. One source path/version snapshot governs the access probe and deferred read, including size-failure rechecks, so conversion cannot publish bytes under another identity. Preview bytes do not enter Session storage or persistent caches.

A converter reuses font metadata obtained by its first conversion Worker; original font buffers and decoded glyph coverage remain conversion-local. Workers validate indexed files when reading them. Exact installed families precede configured alternatives, and complete family/style/weight/italic/width/pitch/language/code-point requests retain their distinct matches. WASM callbacks import original font files, including complete collections, into MEMFS. Native engines also retain their platform's font discovery. Neither path downloads or installs fonts; native OS-managed font memory is outside the explicit import budget. Recreating the converter refreshes its metadata after font changes.

The kit owns default serif, sans-serif, and monospace preference groups, including Chinese text families. Missing Chinese glyphs in Western text try the corresponding common text families before searching the remaining catalog, which avoids choosing a handwriting face solely because its file sorts first. The provider's optional `fontFallbacks` replaces these ordered groups without duplicating their defaults. Preferences preserve exact installed fonts and retain other covering fonts as a last resort; they are not a font whitelist. The native adapter writes missing-family choices into its private VCL profile. Installed metric-compatible fonts can resolve before that table, and platform glyph fallback remains available. Native platform selection and whole collection imports require inspecting the fonts actually used in exported PDFs.

DSH exports raster images at configurable resolution, defaulting to 192 DPI for the shared PDF canvas's 96 CSS DPI at device-pixel ratio 2. Text and vectors remain scalable; explicit bookmark export preserves the engine default when JSON filter options replace it. Node WASM downscales images with LibreOffice's CPU filter. Native conversion uses its separate platform engine.

The [Office viewer](../../../../packages/client/ui-sidebar-documentpreview/README.md#office-preview) lives under Document Preview’s `client/office/` directory, alongside the loading lifecycle, PDF body, and reader types it uses. Keeping these components in one package removes an independent UI boot entry without creating cross-plugin runtime imports. Its bounded cache validates authorized source metadata, shares pending conversions between readers, cancels only when the final reader leaves, excludes failures, and clears on connection reset. Conversion starts when a user opens a preview. Missing declared font families accompany the PDF and are available from the document toolbar’s warning icon; font-table inventories and unrelated engine defaults are not warnings. The shared preview entry’s `office` cache settings use the existing page-global injection channel because the module boot graph carries package identities, not Loader configuration. Reloading the page adopts updated YAML values.

Office responses use Typert binary-result projection and Connection multipart framing. The Client receives one `ArrayBuffer`-backed `Uint8Array` without a base64 string or a separate decode buffer. The built browser scenario verifies the multipart attachment and PDF Worker together. Cache byte limits do not bound transient transport or viewer memory.

The [kit ownership decision](2026-09-14-independent-libreoffice-kit.md) defines npm distribution and bundled offline conversion.

Desktop installs the kit through its existing target-Node pnpm dependency installation and retains the complete dependency tree. Worker paths and executable permissions remain ordinary package files. The [Desktop build guide](../../../../apps/desktop/README.md) owns target selection and packaging; each signed application requires qualification on its target platform.

The [Python executable distribution](2026-07-10-single-file-executable-sdk-runtime-distribution.md) keeps the kit, target engine, and their dependency closure beside the executable. Its installed-wheel smoke relocates the payload, requires exactly the target backend, and converts DOCX once through that engine. Platform packaging and publication constraints belong to the [platform engine decision](2026-09-15-platform-office-engines.md).

The notices gate permits only the exact API and engine package names at MPL-2.0 and continues to reject unrelated MPL or changed non-permissive terms. Each recipient must retain access to the kit’s corresponding LibreOffice source pin, patches, build instructions, and license notices; the engine packages retain their third-party notices. [MPL source availability](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) applies when distributing covered executables outside the organization.

The [browser-only preview](../../../../packages/experimental/webworker-runtime/README.md) replaces the kit entry with an unavailable converter and excludes its engine dependency tree from the VFS image. Keeping the Host provider loadable preserves the ordinary Office error presentation without shipping Node Workers, native helpers, or WASM conversion resources to the browser.

## Alternatives considered

**Keep conversion in browser Workers.** This requires shipping the engine to the Client, browser font RPC, and shared-memory response headers. Node already owns authorized disk access and can serve the resulting PDF to every Client.

**Use the installed soffice CLI or automate Microsoft Office.** Executable discovery and ambient versions weaken reproducibility; Office GUI automation additionally changes focus and requires application permissions. The distributed helper owns a fixed engine without requiring either application installation.

**Load a native addon in the Host process.** A parser crash or synchronous stall would affect the Host. The separate native helper provides an independently terminable lifetime; its disk exchange also works with the WASM adapter.

**Fall back after any native error.** Retrying a damaged package or failed document with another engine hides release defects, duplicates work, and makes output depend on failure timing. Platform selection requires the kit’s declared native target engine, or WASM when no native target is declared; it does not retry native failures with WASM.

**Return a temporary PDF path, or rasterize pages to PNG.** The Client needs PDF bytes for its existing viewer and selectable text. Exposing temporary paths would add authorization and lease ownership; PNG would create another rendering pipeline and remove PDF controls.

**Index every font for every render, or cache only family names.** Repeated indexing dominates small-document work, while family-only keys lose style and glyph distinctions. Shared metadata and complete per-request keys remove repeated parsing without retaining font buffers or introducing a filesystem watcher.

**Compile at install time, download engines or fonts at runtime, or use an online converter.** These add toolchain or network requirements and may move private content off device. Prebuilt tarballs keep installation and conversion independent of those operations.

**Keep an independent Office UI package.** Its reader, cache, and font notice have the same preview lifecycle and PDF presentation consumers. A separate plugin adds a package, boot wiring, and a Loader switch without an independently evolving UI responsibility. Host conversion and Remote authorization retain their separate plugins.

**Remove the shared Client conversion cache.** Per-tab state cannot share pending conversion or retained PDFs across readers. A bounded cache avoids that repeated work while preserving per-reader cancellation and authorized version checks.

**Add a model-facing rendering tool or durable preview events.** Preview provides no model input. Such a tool would require logged facts and both SDK projections and remains a separate consumer.

## Consequences

Native and WASM fidelity still depends on the build, source formatting, installed fonts, and platform font discovery. A missing glyph cannot be recovered without a covering font. Image resolution limits do not cap image decoding or total process memory. WASM retains bounded memory growth and checked stack space for large collections and CFF fonts; a fatal runtime abort prevents subsequent C++ cleanup calls. Macros and document-link updates are disabled by supported LOKit options and the pinned source patch; this does not constitute an OS sandbox.

The [provider tests](../../../../packages/document/office-to-pdf/tests/provider.spec.ts), [Loader composition](../../../../packages/bundle/web-app/tests/document-preview.spec.ts), and [browser scenario](../../../../apps/web/tests/document-preview.e2e.ts) own DSH lifecycle, authorization, and presentation evidence. Engine qualification additionally requires real DOC/DOCX/XLS/XLSX/PPT/PPTX conversion, external PDF text/font/page/image inspection, relocation and corrupted-package rejection, and same-input native/WASM performance samples. Mock helpers and microbenchmarks do not establish these outcomes. Each target's real builder and Desktop package need independent qualification; a successful local architecture does not prove the full matrix.
