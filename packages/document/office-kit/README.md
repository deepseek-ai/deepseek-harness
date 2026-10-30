---
description: "LibreOffice Kit location and Host Office conversion with the independently published kit."
kind: "package-reference"
---

# @deepseek-ai/dsh-office-kit

English | [中文](README.zh.md)

## Summary

Convert Office documents to PDFs on the Host computer. Targets with a declared native LibreOffice engine use it; other targets use Node WASM. The provider accepts DOC, DOCX, XLS, XLSX, PPT, and PPTX. OOXML conversion returns missing-font names; binary Office conversion returns an empty list. The `/locate` entry finds the Kit installation a consumer uses, its CLI, and its engine packages without loading Cordis or Kit.

## Table of Contents

- [Use this package](#use-this-package)
- [Locate Kit](#locate-kit)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [Web bundle](../../bundle/web-app/README.md) mounts this provider as `office-kit`. Independent compositions mount `@deepseek-ai/dsh-office-kit` as a `cordis.yml` row.

Callers submit authorized source identity, version, optional byte size, a deferred bounded read, Office extension, and scheduling priority through `ctx.officeKit.convert()`. A changed source version rejects conversion. Results contain caller-owned PDF bytes, missing fonts, a cache key, and a conversion generation that changes on configuration replacement. Cancellation rejects with its reason; conversion failures use `OfficeKitError`.

The provider depends on the independently published [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-ai/dsh-libreoffice-kit) npm API at kit version `0.2.3`. Application packaging selects the matching native package declared in the kit’s `optionalDependencies`, or WASM when no native package is declared for that target. A missing declared native engine rejects packaging without selecting WASM. The [release ownership decision](../../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md) defines the independent kit and Harness responsibilities.

The provider registers even when its Kit is absent, such as a Python SDK executable launched without a downloaded Office sidecar. A conversion that needs a new converter then rejects with `OfficeKitError` code `unavailable`, and the provider logs each distinct failure once through `ctx.logger`. A Kit entry that fails to import behaves the same way. The provider retains only a successful import, so a later conversion locates and imports Kit again. The Office preview shows its localized `unavailable` message for the `document-render/failed` reason.

Browsers request PDFs through the `officeKit.render` Remote method with a Session identity, Office path, and priority. This entry uses `workspaceFiles` for authorization and source versions, then reads raw bytes through `fs.readBytes` within the conversion reservation. In-process `convert()` does not require those services. Responses retain the source path and version and carry native PDF bytes through the binary Remote multipart transport, plus missing fonts and conversion generation. The `officeKit.generation` Remote method returns the current provider generation; `api/remotes` mounts the generated Client descriptor.

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrentConversions` | `2` | Maximum active converters; queued calls remain cancellable. |
| `timeoutMs` | `60000` | Conversion deadline after a converter is acquired. |
| `maxInputBytes` | `52428800` | Maximum source bytes. |
| `maxOutputBytes` | `104857600` | Maximum complete PDF bytes. |
| `maxImageResolution` | `192` | Maximum raster-image DPI; overrides the kit default of `144`. |
| `fontFallbacks` | Kit defaults | Ordered font-family preference groups; each group requires at least two names containing non-whitespace characters. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-office-kit) owns the full font, archive, and image settings. `fontDirectories` accepts absolute directories; omission uses the kit platform defaults. Explicit `fontFallbacks` replaces the kit's default groups. Installed requested fonts retain precedence, and other system fonts remain eligible for uncovered glyphs. Native engines can select installed metric-compatible fonts before these preferences.

The [bounded conversion decision](../../../.agents/notes/implemented/architecture/2026-09-15-bounded-office-conversion.md) explains queue admission, cache limits, and shared cancellation.

The provider retains successful PDFs by converter generation, Office extension, and SHA-256 of the exact source bytes. A bounded source-version index avoids rereading known content after an authorized stat; content identity also shares conversion across different source paths. Least-recently-used PDFs leave at either retention limit, together with their aliases. Failures and oversized cache entries are not retained. Every result has independent PDF/font buffers. Ready alias hits consume no reader slot; active source locators are released when their last reader leaves. Reopening a source after its final reader cancels rereads its bytes before sharing by digest, even if another source kept the conversion alive or its PDF is ready.

Admission bounds queued metadata, outstanding readers, active source-byte reservations, and conversions before invoking a source read. Unknown source sizes reserve `maxInputBytes`; known sizes reserve their stat size. Reads receive that capacity and may read one overflow sentinel byte. `maxSourceBytes` must cover `maxInputBytes`. The final reader allowance is reserved for foreground work. Setting `maxBackgroundConversions` to zero rejects background joins to queued and running work; completed alias hits remain available. Background jobs wait while any foreground job is queued, including when it awaits source capacity. Foreground joins promote queued prewarming; when its last foreground reader leaves, the queued job returns to background priority and eligible work can start immediately. Foreground admission can evict queued speculation. Background concurrency leaves a foreground slot when total concurrency exceeds one. A running prewarm keeps its background admission slot until settlement, even after promotion. The final reader cancels shared work. Removing a queued foreground blocker immediately admits other eligible work; active reservations remain held until actual read/conversion cleanup settles.

The defaults retain 8 PDFs/128 MiB and 64 source aliases, admit 32 readers and 8 queued jobs, reserve at most 100 MiB of source bytes, and allow one background conversion. These limits bound owned requests and binary payloads, not engine RSS, multipart framing, caller-retained results, or PDF.js page rendering.

<a id="locate-kit"></a>
## Locate Kit

Node consumers that load Kit or run its CLI import `@deepseek-ai/dsh-office-kit/locate`. This entry imports only Node built-in modules as values, reads no environment variables, and has no `cordis.yml` configuration. The consumer owns its Kit dependency. The module and CLI resolvers take a lookup written in the consuming module, because `import.meta.resolve` there selects the consumer's installation and throws when Kit is absent:

```ts
import { resolveKitCli, resolveKitModule } from '@deepseek-ai/dsh-office-kit/locate'

const lookupKitEntry = () => import.meta.resolve('@deepseek-ai/libreoffice-kit')
const kit = resolveKitModule(lookupKitEntry)
const cli = resolveKitCli({ lookupKitEntry })
```

`resolveKitModule` returns `{ kind: 'available', entry, resolveEnginePackage }` or `{ kind: 'missing', error }`. Pass `entry` to a dynamic `import()` and `resolveEnginePackage` to Kit's `createConverter` or `discoverRuntime`, or as `options` in the editor's `openDocument` request. The lookup's thrown value becomes `error`.

`resolveKitCli` accepts optional `node` and `cli` paths and returns `{ kind: 'disabled' }` for `cli: false`, `{ kind: 'missing', error }` when `cli` is omitted and the lookup throws, or `{ kind: 'available', node, cli }`. An omitted `node` uses `process.execPath`; in Electron it throws, because that path is the application binary. An omitted `cli` uses the `./cli` export of the found Kit and maps ASAR paths to their unpacked copies. Explicit CLI paths stay unchanged. A configured or found path that is not an absolute existing file throws. Each call reads the filesystem again.

`root` optionally restricts automatic CLI discovery to an absolute directory; omission leaves it unrestricted, and explicit `cli` bypasses it. The Kit entry and CLI must both lie inside the root after realpath. The root and both paths map their first `.asar` segment, including a root ending in `.asar`, to `.asar.unpacked` before comparison. An unavailable root or an escaping path returns `missing` with its error; a relative root throws.

`unpackedPath(path)` exposes the same mapping for standalone callers that must anchor a lookup outside ASAR, such as packaging smoke checks. It does not access the filesystem.

`createEnginePackageResolver(kitEntry)` creates the engine callback directly from an absolute entry path or file URL; each callback retains its own resolver. A successful callback returns an absolute engine `package.json` path. An absent package preserves Node's original `MODULE_NOT_FOUND`, allowing Kit's native-to-WASM fallback. If a package directory exists, including a dangling symlink, but its manifest cannot resolve, the callback throws an incomplete-installation error with the Node error as `cause`; reinstall that package. Other resolution and filesystem inspection errors propagate unchanged. Kit owns validation of the returned manifest and required assets.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Until a Kit import succeeds, each converter request passes a lookup that returns the provider's own `import.meta.resolve('@deepseek-ai/libreoffice-kit')` to [`resolveKitModule`](src/locate.ts), which returns the Kit entry with an engine-package resolver anchored there, or `missing`. The provider then dynamically imports that entry; it has no static Kit value import. This anchors engine lookup to the Kit installation used by the provider.

The `/locate` functions call the consumer's lookup once per resolution and treat any thrown value as an absent Kit. The CLI resolves through `createRequire(entry)` as the Kit package's own `./cli` export. Automatic CLI and native engine paths share one mapping that replaces only the first `.asar` archive segment with `.asar.unpacked`, regardless of whether the process runs in Electron. Already-unpacked paths and paths outside an archive remain unchanged. `@deepseek-ai/libreoffice-kit-wasm` always keeps Node's logical path for archive-aware filesystem access. These functions do not import Kit, load engine code, register services, mutate module resolution, or retain module-level state; [Desktop packaging](../../../apps/desktop/packaging/README.md#runtime-file-selection) owns which packages are unpacked.

Invalid engine metadata, missing required assets, and conversion errors reject the request instead of switching engines. The shared WASM engine uses LibreOffice's CPU image filter. Native conversion uses its separate platform engine.

Each concurrent slot lazily creates and reuses one kit converter. The provider writes authorized input into a private temporary directory, reads a bounded regular PDF, and removes the directory before settling. Canceling an admitted reader does not block later queued work. Reader cancellation releases only that reader; the final reader and provider disposal cancel shared work. Disposal reports `unavailable` to outstanding readers and joins conversions and converter teardown.

Remote file reads recheck content authorization and source version before consulting the conversion cache. Deferred reads run after conversion admission and verify the source version after reading. Source-read failures pass through; conversion failures return `document-render/failed` with a classified reason and no engine diagnostics. Unload cancels and joins authorization reads, Remote requests, and conversion work.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office Kit](../../../docs/subsystems/office-kit.md) — composition and input/result ownership.
- [Office skills](../../skill/skill-office/README.md) — Kit CLI paths in operation skills.
- [Workspace Files](../../api/workspace-files/README.md) — Session file authorization and bounded reads.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package converts bytes without model-facing tools, messages, or Session events.

#### KV Cache effect

None; conversion does not construct or modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Conversion fidelity and installed native/WASM assets belong to `@deepseek-ai/libreoffice-kit`; this provider neither searches for system LibreOffice nor downloads an engine at runtime.
- Queue waiting time is not bounded by `timeoutMs`, which starts only when kit conversion begins.
- `/locate` consumers must supply a lookup for the Kit installation they use; the functions do not search other locations or install Kit or engines.
- Mapping a native path does not verify that the unpacked copy exists. Kit rejects missing manifests or assets instead of treating them as an absent native package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
