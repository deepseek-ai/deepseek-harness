# Shared textures

English | [中文](shared-texture.zh.md)

The shared-texture seam transfers GPU-backed frames from a Host process to its presentation document without copying pixels through JavaScript. [`@deepseek-ai/dsh-shared-texture`](../../packages/shared-texture/shared-texture/README.md) defines the abstract Host Cordis service `SharedTexture`, a Client plugin that provides the renderer export as `ctx.sharedTexture`, and the renderer types (`SharedTextureClientExport`, `SharedTextureHostExport`, `SharedTextureLease`).

## Host and Client entry points

| Entry | Exports | Role |
|---|---|---|
| `@deepseek-ai/dsh-shared-texture` | `SharedTexture`, `SharedTextureClaim`, `SharedTextureService`, `SharedTextureCapabilities`, `SharedTextureNativeSink`, `apply` | Abstract Host `ctx.sharedTexture` service, which a presentation host such as Desktop Host subclasses; providers own exclusive-claim concurrency control and native transport, and the entry's `apply` does nothing. |
| `@deepseek-ai/dsh-shared-texture/types` | `SharedTextureClientExport`, `SharedTextureHostExport`, `SharedTextureLease` | Cordis-free renderer types for preload and IPC modules, which compile in programs that must not see the Host service declaration. |
| `@deepseek-ai/dsh-shared-texture/client` | `apply`, `SharedTextureClientExport`, `SharedTextureHostExport`, `SharedTextureLease` | Client plugin that web-app mounts; it provides Desktop's `dshDesktop.textures` as `ctx.sharedTexture` and provides nothing in other documents. |

The [Desktop application](../../apps/desktop/README.md) owns the Electron transport, native addons, and preload bridge. Desktop Main compiles against the control-message types the Desktop Host exports ([`apps/desktop-host/src/types.ts`](../../apps/desktop-host/src/types.ts)), so the published package carries only the seam; each side validates every message it receives at runtime. Outside a host that provides shared textures, `ctx.get('sharedTexture')` returns `undefined` on both Host and Client.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsharedtexture--sharedtexture-abstract-seam"></a>

### `ctx.sharedTexture` — `SharedTexture` (abstract seam)

Abstract Host shared-texture service registered as `ctx.sharedTexture`. Subclasses own exclusive-claim concurrency control and the underlying native transport.

```ts cordis-catalog
/**
 * Take the only claim for the calling scope. The claim ends at `release` or when that scope is disposed, whichever
 * comes first; afterwards its operations reject, and the frames of a connection whose
 * {@link SharedTextureService.nativeSink} the claim took settle as invalidated.
 * @returns The texture operations until the claim ends; throws while another claim is held or when the calling scope
 *   is inactive.
 */
abstract claim(): SharedTextureClaim
```

Source: [`packages/shared-texture/shared-texture/src/index.ts`](../../packages/shared-texture/shared-texture/src/index.ts)
<!-- END GENERATED cordis-surface -->
