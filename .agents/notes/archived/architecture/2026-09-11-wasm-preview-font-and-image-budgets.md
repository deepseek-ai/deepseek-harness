# Agent Note: Font reuse and image resolution in WASM previews

Status: implemented
Archived: 2026-09-11

English | [中文](2026-09-11-wasm-preview-font-and-image-budgets.zh.md)

## Problem

Office conversion repeats font metadata parsing across documents and font matching within one document. Image-heavy documents also spend substantial PDF export time resampling images above preview resolution. These costs need separate controls because font reuse does not reduce image decoding or resampling.

## Decision

The [WASM provider](../../../../packages/document/document-render-libreoffice-wasm/README.md) builds a font metadata snapshot once during initialization. Each conversion Worker receives a structured clone. The Host retains names, face attributes, paths, sizes, and modification times; glyph coverage, request caches, and imported bytes belong to the Worker. Reloading the provider refreshes the snapshot. Workers validate indexed files when reading them, and an already imported font remains usable within that conversion.

Each Worker memoizes complete requests: family, style, weight, italic, width, pitch, language, and ordered code points. The cache stores MEMFS paths and missing-family observations. Hits replay those observations because an initialization request can recur after document font collection starts. Worker termination releases both the cache and engine memory.

Runtime PDF filter options reduce raster images to a configurable `maxImageResolution`, defaulting to 192 DPI. The [shared PDF canvas](../../../../packages/client/ui-sidebar-documentpreview/src/client/pdf/document.ts) renders at 96 CSS DPI times the device pixel ratio; the default covers ratio 2. Text and vector graphics remain scalable. Explicit bookmark export preserves LibreOfficeKit's default when JSON filter options replace its implicit filter data.

The [local Office preview decision](2026-09-10-local-office-preview.md) continues to own conversion lifetime, authorization, missing-font presentation, and PDF transport.

## Alternatives considered

**Index fonts inside every conversion Worker.** This keeps discovery off the Host event loop and sees newly installed fonts immediately, but repeats full-file metadata parsing across previews. A provider snapshot removes that repeated work at the cost of synchronous initialization and explicit reload after font changes.

**Cache only the family name.** Style, language, pitch, and missing characters can select different files. A complete request key retains those distinctions and still captures repeated layout requests.

**Keep 300 DPI for every preview.** Higher raster resolution retains detail for high pixel ratios and magnification but increases image export work. The configurable 192-DPI default follows the common display target without rasterizing text or rebuilding the engine.

## Consequences

Cold provider startup includes indexing and remains separate from conversion deadlines. Shared metadata retains no original font buffers, while each Worker still reads selected fonts and lazily decodes coverage. Installing or replacing fonts requires provider reload; a file changed since indexing can fail a later conversion.

Reducing image resolution trades raster detail at high magnification for less export work. It is not an engine memory cap: LibreOffice can still decode full-resolution source images, load large font collections, or exhaust its build-time WASM memory maximum. No persistent font cache, filesystem watcher, or cross-document engine instance is introduced.

[Font tests](../../../../packages/document/document-render-libreoffice-wasm/tests/fonts.spec.ts) cover complete request keys, repeated missing-family observations, snapshot isolation, and failed imports. [Provider tests](../../../../packages/document/document-render-libreoffice-wasm/tests/provider.spec.ts) cover snapshot reuse and reload. The [real-engine tests](../../../../packages/document/document-render-libreoffice-wasm/tests/libreoffice-wasm.e2e.ts) inspect exported image dimensions with default and overridden DPI settings alongside selectable text and page count; ABI forwarding alone cannot establish filter behavior.
