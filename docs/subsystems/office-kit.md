# Office Kit

English | [中文](office-kit.zh.md)

The [document package family](../../packages/document/README.md) renders, converts, and recalculates Office files on the Node Host. Consumers authorize source reads and own presentation; the shared provider owns the engine, bounded admission, transient output reuse, and the private output store. The [`office_render`, `office_convert`, and `office_recalculate` tools](../../packages/document/tool-office/README.md) are the model-facing consumers; the provider itself creates no Session event.

## Ownership

| Owner | Responsibility |
|---|---|
| [office-kit](../../packages/document/office-kit/README.md) | `ctx.officeKit`: shared LibreOffice rendering, conversion, and recalculation, bounded admission, output caching, and the per-Session output store; resolution of the provider's own Kit entry, engine manifests from that installation, and native paths mapped to ASAR unpacked directories |
| [tool-office](../../packages/document/tool-office/README.md) | The on-demand `office_render`, `office_convert`, and `office_recalculate` tools: rendered images in tool results and converted or recalculated files returned for a shell copy |
| [Web bundle](../../packages/bundle/web-app/README.md) and [SDK bundle](../../packages/bundle/sdk-app/README.md) | One configurable provider and `tool-office` shared by Host consumers |
| [Office preview Client](../../packages/client/ui-sidebar-documentpreview/README.md#office-preview) | Office extension selection, PDF reuse, and missing-font notices |

## Requests and results

[`OfficeKitRequest`](../../packages/document/office-kit/src/types.ts) contains an already-authorized source key/version, optional stat size, a deferred `read(signal, maxBytes)` callback, foreground/background priority, and a `OfficeExtension`: `doc`, `docx`, `xls`, `xlsx`, `ppt`, or `pptx`. `OfficeKit.convert(request, signal?)` returns one complete PDF result. `renderImages()` returns bounded PNG images of selected pages, slides, or worksheet areas; `convertTo()` and `recalculate()` save the output under the provider's `outputDirectory` for the request's owner and return its Host path. Their request types accept OpenDocument inputs, and image rendering accepts PDF. All methods share admission and caching. Cancellation follows the caller and provider lifetimes; validation, output, and engine failures reject with a classified `OfficeKitError`.

`OfficeKitPriority` is `foreground` for requested preview/QA and `background` for speculation. `OfficeSourceKey` brands the caller-owned authorized source locator. `OfficeKitGeneration` brands a provider lifetime, and `OfficeKitKey` brands its content identity; neither opaque value is parsed by consumers.

| Result field | Meaning |
|---|---|
| `pdf` | Caller-owned `Uint8Array` containing the complete PDF |
| `missingFonts` | Requested document font families unavailable to this conversion |
| `cacheKey` | Opaque converter generation plus extension/source-content identity |
| `generation` | Provider lifetime; replacement invalidates cached PDF reuse |

The provider admits the deferred read before allocating source bytes, shares conversions by content identity, and removes its private scratch directory before returning. Returned PDF bytes remain valid after provider disposal. Source and PDF bytes do not enter Session storage. Consumers can use [Workspace Files](../../packages/api/workspace-files/README.md) for authorized bounded reads.

## Preview reads

`RenderedDocumentBytes` carries workspace file metadata, native PDF `data`, `missingFonts`, and `generation`; the original source identity accompanies the converted PDF.

The `officeKit.render` Remote method checks source authorization and versions through the Session's [Workspace Files](../../packages/api/workspace-files/README.md) service. After conversion admission, `fs.readBytes` supplies raw input within the reserved byte capacity; Office input limits govern this read. The binary Remote projects the PDF into a multipart attachment and restores an `ArrayBuffer`-backed `Uint8Array` on the Client. Source access failures pass through; size and engine failures expose a classified reason without diagnostics. Conversion does not activate an Agent or append events.

The `api/remotes` assembly mounts the conversion service's generated Remote descriptor. The shared Document Preview package registers Office formats with complete-byte loading and its existing PDF.js Worker. Each preview read rechecks renderer generation, source authorization, and version before sharing an in-flight conversion or cached PDF. Connection resets and plugin disposal cancel requests and clear cached bytes. Missing services show localized configuration guidance.

## Engine selection and limits

The external [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-ai/dsh-libreoffice-kit) Node API selects its precompiled engines. The kit has an independent version and release workflow, defined by the [release ownership decision](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md). Application builds install the published npm packages. Application packaging requires the target’s declared native engine, or Node WASM when the kit declares no native engine for that target. The [platform engine reference](../../packages/document/office-kit/README.md) defines installation and packaging. Invalid metadata, missing required assets, and conversion errors reject without switching engines. When the provider's Kit is absent or fails to import, the provider still registers and rejects conversions as `unavailable`. Conversion uses disk input and output paths on the Host, with no browser conversion engine or font RPC.

The [Host provider configuration](../../packages/document/office-kit/README.md#use-this-package) owns concurrency, deadlines, input/output limits, archive limits, image resolution, and font access. Native/WASM implementation and asset distribution belong to the kit workspace. System LibreOffice discovery, runtime engine downloads, persistent output caching, workspace writes, and model-facing presentation are outside this provider.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxofficekit--officekit"></a>

### `ctx.officeKit` — `OfficeKit`

A provider lifetime owns all converters, queued calls, and temporary files.

```ts cordis-catalog
/**
 * Convert Office bytes to PDF without modifying the source or writing Session events.
 * @param request - authorized metadata and deferred bounded source read.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
 * @throws {OfficeKitError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
async convert(request: OfficeKitRequest, signal?: AbortSignal): Promise<OfficeKitResult>

/**
 * Render selected pages, slides, or worksheet areas of one document as PNG images. Requests share the admission
 * queue, concurrency, source-byte reservation, and cache with previews, and run at foreground priority.
 * @param request - authorized metadata, deferred bounded source read, selection, and complete-result limits.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned images in document order whose count, per-image size, and total bytes satisfy the limits.
 * @throws {OfficeKitError} `invalid-request` for a selection the engine rejects, `output-too-large` when the
 * selection exceeds a limit, and the other conversion codes; cancellation rejects with its reason.
 */
async renderImages(request: OfficeImagesRequest, signal?: AbortSignal): Promise<OfficeImagesResult>

/**
 * Convert one document to another format at foreground priority, sharing admission, concurrency, and cache with
 * previews, and save the result in the provider's output store.
 * @param request - authorized metadata, deferred bounded source read, target format, and output owner and name.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns the saved file's absolute Host path and size; the file is deleted after `outputRetentionMs`, when older
 * outputs need `maxOutputStoreBytes`, when the Session whose id is `output.owner` is disposed, or when the provider is disposed.
 * @throws {OfficeKitError} `invalid-request` for a format or sheet the engine rejects and the other conversion
 * codes; cancellation rejects with its reason.
 */
async convertTo(request: OfficeConversionRequest, signal?: AbortSignal): Promise<OfficeFileResult>

/**
 * Recalculate every formula of one workbook at foreground priority and save formulas with refreshed cached results, sharing admission,
 * concurrency, and cache with previews, and save the workbook in the provider's output store. This does not validate
 * formulas or business data.
 * @param request - authorized workbook metadata, deferred bounded source read, output format, and output owner and name.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns the saved workbook's absolute Host path and size, retained like {@link convertTo} outputs.
 * @throws {OfficeKitError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
async recalculate(request: OfficeRecalculationRequest, signal?: AbortSignal): Promise<OfficeFileResult>

/**
 * Read and convert one Office file using the Session's ordinary filesystem authorization.
 * @param workspaceFileScope - Session header lookup shared with workspaceFiles.
 * @param path - absolute or workspace-relative Office path.
 * @param priority - foreground preview or speculative background work.
 * @param signal - Remote cancellation; disposal also cancels outstanding reads and conversions.
 * @returns complete PDF bytes with original source identity and missing font families.
 */
@Remote async render( workspaceFileScope: WorkspaceFileScope, path: string, priority: OfficeKitPriority, signal: AbortSignal, ): Promise<RenderedDocumentBytes>

/**
 * Read the current rendering generation before reusing a Client PDF.
 * @param signal - Remote caller cancellation.
 * @returns provider lifetime, replaced with rendering, font, or engine configuration.
 */
@Remote('generation') getGeneration(signal: AbortSignal): OfficeKitGeneration
```

Source: [`packages/document/office-kit/src/index.ts`](../../packages/document/office-kit/src/index.ts)
<!-- END GENERATED cordis-surface -->
