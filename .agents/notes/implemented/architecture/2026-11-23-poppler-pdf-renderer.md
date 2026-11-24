# Agent Note: Poppler PDF rendering with per-type renderer order

Status: implemented

English | [中文](2026-11-23-poppler-pdf-renderer.zh.md)

## Problem

`document_render` rasterized every input, including PDF, in the Office kit's LibreOffice converter. That converter is a resident process of roughly 600 to 900 MiB per instance. Rendering a scanned PDF of more than 280 pages in a Linux x64 container limited to 2 GiB ran out of memory. PDF rasterization does not need an Office engine, and Hosts often have Poppler's `pdftoppm` and `pdfinfo` installed.

## Decision

The [Office kit](../../../../packages/document/office-kit/README.md) has two image rendering backends, `libreoffice` and `poppler`. `OfficeImagesRequest.renderer` selects one exclusively; `poppler` accepts only PDF, and an unavailable requested backend fails with `unavailable`. Without `renderer`, the provider takes the first available backend from its `renderers` configuration for the input type, by default `office: [libreoffice]` and `pdf: [poppler, libreoffice]`, and uses the last entry without an availability check. Only unavailability moves selection to the next entry. LibreOffice is available when Kit imports; Poppler is available when the `subprocess` service exists and resolves both configured executables. The backend is resolved before queue admission and recorded in the operation, so the result names it and cached renderings never cross backends.

Poppler runs as short-lived subprocesses through `ctx.subprocess` with argv only and no LibreOffice converter slot, while sharing the queue's admission, concurrency, and source-byte reservations. No file passes between the provider and a process: each process reads the PDF from stdin, written with backpressure, and `pdftoppm` writes its PNG images to stdout one after another. The Poppler path therefore works in whatever execution world the subprocess provider runs processes, including an SSH host, and needs no filesystem provider. Each process runs in the directory of its resolved executable, which exists in that world. One `pdfinfo` reports the page count, read from its last `Pages:` line because document properties such as the title print earlier and can contain forged lines. The provider rejects a selection with more pages than `maxImages` or a page outside the document with the LibreOffice error codes before rendering. `pdftoppm -cropbox` renders each run of consecutive pages once; the provider splits its stdout at PNG chunk boundaries as bytes arrive, terminates it once the bytes exceed the remaining budget, and requires one image per page. Page pixels and dimensions are checked only after rendering, against each PNG header, and an image above `maxPixels` or `maxDimension` fails with `output-too-large`. One `timeoutMs` deadline covers all processes of a rendering; cancellation, the deadline, and provider disposal terminate the running process, and each call settles only after the process exits.

[`document_render`](../../../../packages/document/tool-document/README.md) exposes `renderer` to the model, refuses `poppler` for non-PDF input before reading it, and reports the backend in its result text. An unavailable explicit `poppler` request tells the model to omit `renderer` or choose `libreoffice`.

## Alternatives considered

**Keep LibreOffice as the only renderer.** Raising the container limit or lowering concurrency does not change the resident engine's footprint, and LibreOffice imports a PDF as a drawing document, which spends memory that rasterization does not need.

**Let the model run `pdftoppm` in the shell.** The model would have to discover the executables, manage temporary PNG files, and read them back, and the sandbox and approvals of each deployment would decide whether rendering works at all. The tool keeps rendering bounded by the same image limits and attachment flow for every backend.

**Name the choices `builtin` and `system`.** These names describe packaging rather than the rasterizer, become ambiguous if Poppler is ever bundled or LibreOffice is found on the system, and do not tell the model which output to expect. Engine names stay accurate across deployments.

**Fall back to the next renderer after a runtime failure.** A Poppler failure on a damaged or encrypted PDF would silently rerun the request in the memory-heavy engine the change avoids, double the deadline, and hide which backend produced the result or the error. Only unavailability, detected before admission, moves selection.

**Check page sizes with `pdfinfo` before rendering.** `pdfinfo -box` reports each page's crop box and rotation, so oversized pages could be refused before any rasterization. Poppler accepts only an inclusive page range per call and renders page by page, so the check needs one more process that receives the whole PDF, and a sparse selection lists every page between its first and last page. The post-render check against each PNG header already enforces the limits with the dimensions `pdftoppm` actually produced; the cost is the transient memory of rendering an oversized page before refusing it.

**Exchange files through a Host temporary directory and treat Poppler as unavailable when the subprocess world cannot read Host files.** Writing `source.pdf` and reading `page-N.png` files needs a filesystem shared with the process. The mounted filesystem provider's Host path mapping can detect an SSH composition, but then PDF rendering silently returns to LibreOffice there, and the result depends on how the filesystem and subprocess providers happen to be paired. Pipes make the Poppler path independent of the execution world and remove the scratch directory and file-name parsing.

**Document that Poppler requires a Host subprocess provider.** The provider would still spawn Poppler in an SSH composition with Host paths the remote process cannot open, and every such rendering would fail as `invalid-document` instead of working or being skipped.

## Consequences

PDF rendering no longer starts a LibreOffice converter where Poppler is installed, and its memory ends with each process. Poppler processes run outside the DSH sandbox with no memory limit other than the operating system's, only `timeoutMs` bounds them, and the provider neither installs Poppler nor checks its version. With SSH providers, Poppler must be installed on the SSH host, and the PDF crosses the connection once per process. Each rendering starts one `pdfinfo` for the page count and one `pdftoppm` per run of consecutive pages, each receiving the complete PDF. Because page sizes are checked after rendering, an oversized page is rasterized before it is refused, and its image briefly occupies memory in `pdftoppm` and in the provider's PNG buffer, bounded by the remaining `maxBytes`. Poppler and LibreOffice rasterize pages differently, so the same request can produce different images depending on whether Poppler is available; the result's `renderer` field and text make the difference visible.

Office kit tests drive a scripted subprocess provider with stdin and stdout streams through backend order and fallback, explicit and unavailable requests, run splitting, document properties that forge an earlier `Pages:` line, PNG splitting across reads, image-count mismatches, malformed and truncated PNG streams, pixel and dimension limits at and above their bounds after rendering, count and byte limits at and above their bounds, slow and failing stdin, exit-code mapping, deadline, cancellation, and disposal termination, per-backend caching, and configuration validation. A further spec renders generated PDFs, including one whose title forges a smaller page count, with real Poppler through the local subprocess provider when it resolves both executables. Tool tests cover the `renderer` argument, its refusal for non-PDF input, the result text, and the unavailable hint.

## Related

The [bounded shared Office conversion note](2026-09-15-bounded-office-conversion.md) owns the queue, cache, and admission that both backends share.
