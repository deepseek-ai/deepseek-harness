# Agent Note: Local Office preview through WASM PDF bytes

Status: implemented
Archived: 2026-09-11

English | [中文](2026-09-10-local-office-preview.zh.md)

## Problem

Office Open XML files are ZIP archives, so text fallback cannot provide a useful preview. Document conversion must stay local without taking focus or adding document content to a model conversation. Engine success alone cannot prove that the input has the claimed format or that a PDF was produced.

## Decision

A [document-render Service Definition](../../../../packages/document/document-render/README.md), a LibreOffice WASM provider, and Client/API consumers form the conversion capability. [Boot composition](../../../../packages/document/document-render-auto/README.md) mounts the provider and Remote controller only when `wasm.artifactDirectory` is configured. Invalid explicit configuration fails initialization. The Office Client registration always exists so an unconfigured Host receives guidance. Availability follows the generated Remote namespace without executable discovery or a duplicate Client flag.

The [WASM provider](../../../../packages/document/document-render-libreoffice-wasm/README.md) uses pinned official LibreOffice source, Emscripten, and a LibreOfficeKit adapter. Each Node Worker owns one engine instance, its pthreads, and its memory filesystem. Terminating the Worker cancels synchronous engine calls; every conversion waits for its Worker to stop before returning. OOXML inspection verifies archive membership, content type, and resource bounds before startup.

A VCL callback requests a font family before substitution or missing Unicode characters during glyph fallback. Host code indexes installed font metadata and copies selected files into engine memory, including complete font collections. Exact installed families precede configured alternatives; original-first fontconfig aliases preserve that ordering inside LibreOffice. Optional initial families use the same resolver. The engine has no Host filesystem mount, and rendering neither installs nor downloads fonts. The [build recipe](../../../../native/libreoffice-wasm/README.md) records source and toolchain revisions, patches, and asset hashes. Engine bundles remain immutable during provider use; a different build uses a new directory.

The [independent engine release](../process/2026-09-11-independent-libreoffice-package.md) owns precompiled npm packaging and keeps engine compilation outside ordinary DSH builds.

The provider returns caller-owned PDF bytes and independent `succeeded`, `timedOut`, and `cancelled` facts. PDF bytes are copied out of engine memory before teardown. The API consumer authorizes the source through [Workspace Files](2026-09-09-workspace-file-read-authority.md), requires successful uninterrupted conversion, and encodes the PDF directly. Source path and freshness version survive the PDF transport. Workspace Files limits source reads; the provider's `maxOutputBytes` alone limits generated PDFs. No temporary PDF or file lease is needed.

The Office Client watches the selected Conversation's existing Deliverables projection and warms recent Office files without opening tabs. Its bounded memory cache checks authorized source metadata on every read and shares pending conversions between background and foreground callers. Only the last departing reader cancels a shared conversion; failures are not cached and connection reset discards cached bytes. [Document Preview](2026-09-08-document-preview-operations.md) owns format selection, loading, cancellation, and the PDF.js Worker.

PDF.js's official TextLayerBuilder owns selection boundaries and copy normalization over the width-fitted canvas, with shared page cleanup and a component-owned resize observer. Its end-of-content marker and stacking rules constrain selection in blank regions; line-break highlighting is suppressed. Per-page cancellation uses the builder's cleanup rather than aborting the first page's signal, because the official selection listeners are shared across pages.

Missing-family observations accompany the PDF through the worker and Remote response. The Office plugin renders a keyed notice above the shared PDF scrollport, so dismissing it removes its layout height. The font resolver intersects explicit source and theme references with actual document requests, excluding engine defaults and font-table inventories; installed aliases and glyph fallback do not by themselves mean a family is absent.

## Alternatives considered

**Keep an installed native LibreOffice provider.** A second provider adds executable discovery, version queries, subprocess supervision, scratch files, and platform-specific confinement. This design uses WASM for all supported Office previews. A native provider needs a demonstrated rendering or deployment requirement that WASM cannot satisfy.

**Return a temporary PDF path.** The Worker already supplies independent PDF bytes. Writing them to disk, authorizing another file read, and maintaining leases adds file ownership without a current consumer. Source authorization and output limits apply directly to the memory result.

**Automate installed Microsoft Office.** Word for Mac requires GUI automation rather than headless conversion, introducing focus changes and per-file operating-system authorization. Native Office automation remains outside this preview capability.

**Use an online converter or download the engine automatically.** Remote conversion uploads document content. Automatic installation adds runtime distribution and update responsibilities; explicit artifact configuration leaves deployment with the operator.

**Convert PDF pages to PNG.** PDF.js already owns PDF presentation. Rasterizing adds another image pipeline and loses the existing PDF controls and selectable text.

**Add a model-facing rendering tool or durable preview events.** Client preview does not supply model input. A model-facing tool requires logged facts and both SDK projections, so it is a separate consumer.

**Scan every font-table entry for warnings.** Font tables include unused styles and templates. Reporting them would make the notice unrelated to rendered content; collection instead starts after engine initialization and ends after PDF save.

## Consequences

The single-provider design assumes WASM covers the required Office rendering behavior; it is not evidence of complete fidelity equivalence with native LibreOffice. Fidelity depends on the engine build and installed fonts. The [real-engine tests](../../../../packages/document/document-render-libreoffice-wasm/tests/libreoffice-wasm.e2e.ts) cover DOCX, XLSX, PPTX, selectable Chinese text, and embedded system fonts; ABI fixtures alone cannot establish rendering fidelity or assembled browser presentation.

WASM instances have substantial memory and startup costs, so the provider bounds concurrency. The [font reuse and image resolution decision](2026-09-11-wasm-preview-font-and-image-budgets.md) owns shared Host metadata, Worker request memoization, and raster export limits; only selected fonts enter engine memory. Large collections require bounded memory growth, and CFF export requires checked stack space. A fatal abort prevents further calls into C++. A device without a font covering a character cannot render it correctly without additional fonts. Owning the WASM build adds compiler compatibility, patch maintenance, and redistribution obligations.

Prewarming consumes conversion resources to reduce foreground waits; entry and byte limits bound retained Client results. Source and PDF bytes remain outside Session storage and persistent caches. The [provider tests](../../../../packages/document/document-render-libreoffice-wasm/tests/provider.spec.ts) cover independent output facts, input/output rejection, queued cancellation, and active Worker termination. Existing preview registry, file read authority, and Session ownership decisions remain active.
