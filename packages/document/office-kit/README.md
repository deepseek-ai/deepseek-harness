---
description: "Host Office rendering, conversion, and recalculation with the independently published kit."
kind: "package-reference"
---

# @deepseek-ai/dsh-office-kit

English | [中文](README.zh.md)

## Summary

Render Office documents as PDFs or PNG images, convert them between formats, and recalculate workbooks on the Host computer. Targets with a declared native LibreOffice engine use it; other targets use Node WASM. Previews accept DOC, DOCX, XLS, XLSX, PPT, and PPTX; operations also accept the OpenDocument formats, and image rendering accepts PDF. OOXML operations return missing-font names; binary Office operations return an empty list.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [Web bundle](../../bundle/web-app/README.md) and the [SDK bundle](../../bundle/sdk-app/README.md) mount this provider as `office-kit`; the [Office tools](../tool-office/README.md) are its model-facing consumers. Independent compositions mount `@deepseek-ai/dsh-office-kit` as a `cordis.yml` row.

Callers submit authorized source identity, version, optional byte size, a deferred bounded read, and input extension; PDF conversions also name a scheduling priority, and image rendering, format conversion, and recalculation run at foreground priority. A changed source version rejects the operation. Cancellation rejects with its reason; failures use `OfficeKitError`. Every result carries the missing fonts; PDF results also carry the conversion generation, which changes on configuration replacement.

| Method | Operation | Result |
|---|---|---|
| `convert()` | Office to PDF for previews | caller-owned PDF bytes and a cache key |
| `renderImages()` | selected pages, slides, or worksheet areas to PNG | images in document order with their page, sheet, or range, plus the document page count and DPI |
| `convertTo()` | conversion to the format of `format`; CSV takes a `sheet` | the saved file's Host path, size, and PDF page count |
| `recalculate()` | XLS, XLSX, or ODS recalculation to XLSX or ODS | the saved workbook's Host path and size |

`renderImages()` requires `maxImages`, `maxPixels`, `maxDimension`, and `maxBytes`. The engine rejects a selection with more images than `maxImages` or an image above the pixel or dimension limit; the provider rejects images whose total PNG bytes exceed `maxBytes` with `output-too-large`, before and while reading them. A page, sheet, range, resolution, or format selection the engine rejects fails with `invalid-request` and the engine's description. Converted and recalculated files obey `maxOutputBytes`. The provider never writes into a workspace: it saves each output in its own owner-only directory under `outputDirectory`, grouped by the request's `output.owner` (`office_convert` and `office_recalculate` pass the root Session of the caller's subagent tree), and returns the absolute Host path. A file is deleted after `outputRetentionMs`, when newer outputs need room within `maxOutputStoreBytes` (oldest first), when the Session whose id equals the owner is disposed, or when the provider unloads; a file larger than `maxOutputStoreBytes` fails with `output-too-large`. A file counts toward `maxOutputStoreBytes` until its deletion succeeds; a failed deletion is logged and retried by later eviction, release, and unload, and a save that cannot free enough room fails with `unavailable`. Unload waits for deletions in progress. Startup also removes expired output directories of earlier processes, considering only real directories, not links or junctions, with the names the provider generates: `session-` and 24 lowercase hexadecimal digits directly under `outputDirectory`, each holding lowercase UUID v4 output directories. Other entries are left untouched. `outputDirectory` is exposed on the service so consumers can check that their execution world reads it.

The provider depends on the independently published [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-ai/dsh-libreoffice-kit) npm API at kit version `0.2.3`. Application packaging selects the matching native package declared in the kit’s `optionalDependencies`, or WASM when no native package is declared for that target. A missing declared native engine rejects packaging without selecting WASM. The [release ownership decision](../../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md) defines the independent kit and Harness responsibilities.

The provider registers even when its Kit is absent, such as a Python SDK executable launched without a downloaded Office sidecar. A conversion that needs a new converter then rejects with `OfficeKitError` code `unavailable`, and the provider logs each distinct failure once through `ctx.logger`. A Kit entry that fails to import behaves the same way. The provider retains only a successful import, so a later conversion locates and imports Kit again. The Office preview shows its localized `unavailable` message for the `document-render/failed` reason.

Browsers request PDFs through the `officeKit.render` Remote method with a Session identity, Office path, and priority. This entry uses `workspaceFiles` for authorization and source versions, then reads raw bytes through `fs.readBytes` within the conversion reservation. In-process `convert()` does not require those services. Responses retain the source path and version and carry native PDF bytes through the binary Remote multipart transport, plus missing fonts and conversion generation. The `officeKit.generation` Remote method returns the current provider generation; `api/remotes` mounts the generated Client descriptor.

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrentConversions` | `2` | Maximum active converters; queued calls remain cancellable. |
| `timeoutMs` | `60000` | Conversion deadline after a converter is acquired. |
| `maxInputBytes` | `52428800` | Maximum source bytes. |
| `maxOutputBytes` | `104857600` | Maximum complete PDF, converted, or recalculated file bytes. |
| `outputDirectory` | `$DSH_HOME/office-kit/outputs` | Absolute directory for converted and recalculated files. |
| `outputRetentionMs` | `86400000` | Milliseconds an output is kept. |
| `maxOutputStoreBytes` | `536870912` | Maximum bytes across retained outputs. |
| `maxImageResolution` | `192` | Image resolution in DPI of PDF exports; overrides the kit default of `144`. `renderImages()` uses each request's `dpi` instead. |
| `fontFallbacks` | Kit defaults | Ordered font-family preference groups; each group requires at least two names containing non-whitespace characters. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-office-kit) owns the full font, archive, and image settings. `fontDirectories` accepts absolute directories; omission uses the kit platform defaults. Explicit `fontFallbacks` replaces the kit's default groups. Installed requested fonts retain precedence, and other system fonts remain eligible for uncovered glyphs. Native engines can select installed metric-compatible fonts before these preferences.

The [bounded conversion decision](../../../.agents/notes/implemented/architecture/2026-09-15-bounded-office-conversion.md) explains queue admission, cache limits, and shared cancellation.

All four methods share one admission queue, so tool operations and previews compete for the same converters, reservations, and cache. The provider retains successful outputs by converter generation, input extension, the operation and its parameters, and SHA-256 of the exact source bytes. A bounded source-version index avoids rereading known content after an authorized stat; content identity also shares conversion across different source paths. Least-recently-used outputs leave at either retention limit, together with their aliases. Failures and oversized cache entries are not retained. Every result has independent byte and font buffers. Ready alias hits consume no reader slot; active source locators are released when their last reader leaves. Reopening a source after its final reader cancels rereads its bytes before sharing by digest, even if another source kept the conversion alive or its PDF is ready.

Admission bounds queued metadata, outstanding readers, active source-byte reservations, and conversions before invoking a source read. Unknown source sizes reserve `maxInputBytes`; known sizes reserve their stat size. Reads receive that capacity and may read one overflow sentinel byte. `maxSourceBytes` must cover `maxInputBytes`. The final reader allowance is reserved for foreground work. Setting `maxBackgroundConversions` to zero rejects background joins to queued and running work; completed alias hits remain available. Background jobs wait while any foreground job is queued, including when it awaits source capacity. Foreground joins promote queued prewarming; when its last foreground reader leaves, the queued job returns to background priority and eligible work can start immediately. Foreground admission can evict queued speculation. Background concurrency leaves a foreground slot when total concurrency exceeds one. A running prewarm keeps its background admission slot until settlement, even after promotion. The final reader cancels shared work. Removing a queued foreground blocker immediately admits other eligible work; active reservations remain held until actual read/conversion cleanup settles.

The defaults retain 8 outputs/128 MiB and 64 source aliases, admit 32 readers and 8 queued jobs, reserve at most 100 MiB of source bytes, and allow one background conversion. These limits bound owned requests and binary payloads, not engine RSS, multipart framing, caller-retained results, or PDF.js page rendering.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Until a Kit import succeeds, each converter request passes a lookup that returns the provider's own `import.meta.resolve('@deepseek-ai/libreoffice-kit')` to [`resolveKitModule`](src/locate.ts), which returns the Kit entry with an engine-package resolver anchored there, or `missing`. The provider then dynamically imports that entry; it has no static Kit value import. This anchors engine lookup to the Kit installation used by the provider.

The engine-package resolver is created from the Kit entry; each resolver is independent. A successful call returns an absolute engine `package.json` path. An absent package preserves Node's original `MODULE_NOT_FOUND`, allowing Kit's native-to-WASM fallback. If a package directory exists, including a dangling symlink, but its manifest cannot resolve, the resolver throws an incomplete-installation error with the Node error as `cause`; reinstall that package. Other resolution and filesystem inspection errors propagate unchanged. Kit owns validation of the returned manifest and required assets.

The locate functions call the provider's lookup once per resolution and treat any thrown value as an absent Kit. Native engine paths use one mapping that replaces only the first `.asar` archive segment with `.asar.unpacked`, regardless of whether the process runs in Electron. Already-unpacked paths and paths outside an archive remain unchanged. `@deepseek-ai/libreoffice-kit-wasm` always keeps Node's logical path for archive-aware filesystem access. These functions do not import Kit, load engine code, register services, mutate module resolution, or retain module-level state; [Desktop packaging](../../../apps/desktop/packaging/README.md#runtime-file-selection) owns which packages are unpacked.

Invalid engine metadata, missing required assets, and conversion errors reject the request instead of switching engines. The shared WASM engine uses LibreOffice's CPU image filter. Native conversion uses its separate platform engine.

Each concurrent slot lazily creates and reuses one kit converter. The provider writes authorized input into a private temporary directory, reads bounded regular output files from it, refuses image paths outside its image directory, and removes the directory before settling. Canceling an admitted reader does not block later queued work. Reader cancellation releases only that reader; the final reader and provider disposal cancel shared work. Disposal reports `unavailable` to outstanding readers and joins conversions and converter teardown.

Remote file reads recheck content authorization and source version before consulting the conversion cache. Deferred reads run after conversion admission and verify the source version after reading. Source-read failures pass through; conversion failures return `document-render/failed` with a classified reason and no engine diagnostics. Unload cancels and joins authorization reads, Remote requests, and conversion work.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office Kit](../../../docs/subsystems/office-kit.md) — composition and input/result ownership.
- [Office tool](../tool-office/README.md) — the model-facing render, convert, and recalculate tool.
- [Workspace Files](../../api/workspace-files/README.md) — Session file authorization and bounded reads.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [the Office tools](../tool-office/README.md#model-experience), which return rendered images and converted files from this service.

#### KV Cache effect

None; this service does not construct or modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Conversion fidelity and installed native/WASM assets belong to `@deepseek-ai/libreoffice-kit`; this provider neither searches for system LibreOffice nor downloads an engine at runtime.
- Queue waiting time is not bounded by `timeoutMs`, which starts only when kit conversion begins.
- The provider locates only the Kit installation it resolves itself; it does not search other locations or install Kit or engines.
- Rendered images are returned as bytes. Converted and recalculated files are stored in the provider's output directory, not in the workspace; the caller copies each file to its destination.
- Mapping a native path does not verify that the unpacked copy exists. Kit rejects missing manifests or assets instead of treating them as an absent native package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
