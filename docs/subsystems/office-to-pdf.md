# Office to PDF

English | [中文](office-to-pdf.zh.md)

The [document package family](../../packages/document/README.md) converts Office files to PDFs on the Node Host. Consumers authorize source reads and own presentation; the shared provider owns conversion, bounded admission, and transient PDF reuse. This subsystem creates no model-facing tool or Session event.

## Ownership

| Owner | Responsibility |
|---|---|
| [office-to-pdf](../../packages/document/office-to-pdf/README.md) | `ctx.officeToPdf`: shared LibreOffice conversion, bounded admission, and PDF caching |
| [Web bundle](../../packages/bundle/web-app/README.md) | One configurable conversion provider shared by Host consumers |
| [Office preview Client](../../packages/client/ui-sidebar-documentpreview/README.md#office-preview) | Office extension selection, PDF reuse, and missing-font notices |

## Requests and results

[`OfficeToPdfRequest`](../../packages/document/office-to-pdf/src/types.ts) contains an already-authorized source key/version, optional stat size, a deferred `read(signal, maxBytes)` callback, foreground/background priority, and a `OfficeExtension`: `doc`, `docx`, `xls`, `xlsx`, `ppt`, or `pptx`. `OfficeToPdf.convert(request, signal?)` returns one complete PDF result. Cancellation follows the caller and provider lifetimes; validation, output, and engine failures reject with a classified `OfficeToPdfError`.

`OfficeToPdfPriority` is `foreground` for requested preview/QA and `background` for speculation. `OfficeSourceKey` brands the caller-owned authorized source locator. `OfficeToPdfGeneration` brands a provider lifetime, and `OfficeToPdfKey` brands its content identity; neither opaque value is parsed by consumers.

| Result field | Meaning |
|---|---|
| `pdf` | Caller-owned `Uint8Array` containing the complete PDF |
| `missingFonts` | Requested document font families unavailable to this conversion |
| `cacheKey` | Opaque converter generation plus extension/source-content identity |
| `generation` | Provider lifetime; replacement invalidates cached PDF reuse |

The provider admits the deferred read before allocating source bytes, shares conversions by content identity, and removes its private scratch directory before returning. Returned PDF bytes remain valid after provider disposal. Source and PDF bytes do not enter Session storage. Consumers can use [Workspace Files](../../packages/api/workspace-files/README.md) for authorized bounded reads.

## Preview reads

`RenderedDocumentBytes` carries workspace file metadata, native PDF `data`, `missingFonts`, and `generation`; the original source identity accompanies the converted PDF.

The `officeToPdf.render` Remote method checks source authorization and versions through the Session's [Workspace Files](../../packages/api/workspace-files/README.md) service. After conversion admission, `fs.readBytes` supplies raw input within the reserved byte capacity; Office input limits govern this read. The binary Remote projects the PDF into a multipart attachment and restores an `ArrayBuffer`-backed `Uint8Array` on the Client. Source access failures pass through; size and engine failures expose a classified reason without diagnostics. Conversion does not activate an Agent or append events.

The `api/remotes` assembly mounts the conversion service's generated Remote descriptor. The shared Document Preview package registers Office formats with complete-byte loading and its existing PDF.js Worker. Each preview read rechecks renderer generation, source authorization, and version before sharing an in-flight conversion or cached PDF. Connection resets and plugin disposal cancel requests and clear cached bytes. Missing services show localized configuration guidance.

## Engine selection and limits

The external [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-harness/libreoffice-kit) Node API selects its precompiled engines. The kit has an independent version and release workflow, defined by the [release ownership decision](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md). Application builds install the published npm packages. Application packaging requires the target’s declared native engine, or Node WASM when the kit declares no native engine for that target. The [platform engine decision](../../.agents/notes/implemented/architecture/2026-09-15-platform-office-engines.md) defines installation and packaging. Invalid metadata, missing required assets, and conversion errors reject without switching engines. Conversion uses disk input and output paths on the Host, with no browser conversion engine or font RPC.

The [Host provider configuration](../../packages/document/office-to-pdf/README.md#use-this-package) owns concurrency, deadlines, input/output limits, archive limits, image resolution, and font access. Native/WASM implementation and asset distribution belong to the kit workspace. System LibreOffice discovery, runtime engine downloads, persistent PDF caching, and model-facing rendering are outside this provider.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxofficetopdf--officetopdf"></a>

### `ctx.officeToPdf` — `OfficeToPdf`

A provider lifetime owns all converters, queued calls, and temporary files.

```ts cordis-catalog
/**
 * Convert Office bytes without modifying the source or writing Session events.
 * @param request - authorized metadata and deferred bounded source read.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
 * @throws {OfficeToPdfError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
convert(request: OfficeToPdfRequest, signal?: AbortSignal): Promise<OfficeToPdfResult>

/**
 * Read and convert one Office file using the Session's ordinary filesystem authorization.
 * @param workspaceFileScope - Session header lookup shared with workspaceFiles.
 * @param path - absolute or workspace-relative Office path.
 * @param priority - foreground preview or speculative background work.
 * @param signal - Remote cancellation; disposal also cancels outstanding reads and conversions.
 * @returns complete PDF bytes with original source identity and missing font families.
 */
@Remote async render( workspaceFileScope: WorkspaceFileScope, path: string, priority: OfficeToPdfPriority, signal: AbortSignal, ): Promise<RenderedDocumentBytes>

/**
 * Read the current rendering generation before reusing a Client PDF.
 * @param signal - Remote caller cancellation.
 * @returns provider lifetime, replaced with rendering, font, or engine configuration.
 */
@Remote('generation') getGeneration(signal: AbortSignal): OfficeToPdfGeneration
```

Source: [`packages/document/office-to-pdf/src/index.ts`](../../packages/document/office-to-pdf/src/index.ts)
<!-- END GENERATED cordis-surface -->
