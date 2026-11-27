---
description: "Host and Client shared-texture Cordis services (ctx.sharedTexture) and pure renderer bridge types."
kind: "package-reference"
---

# @deepseek-ai/dsh-shared-texture

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-shared-texture` to present or receive shared GPU-backed frames through `ctx.sharedTexture` without depending on Electron or Desktop internals. Its Host entry defines the abstract `SharedTexture` service, which a presentation host such as Desktop Host subclasses to grant exclusive claims (`claim()`). Its Client half is a plugin that provides the host shell's `SharedTextureClientExport` as the Client `ctx.sharedTexture`, and preload or IPC modules import the renderer types from the Cordis-free `./types` subpath.

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

### Host service (`@deepseek-ai/dsh-shared-texture`)

A presentation host subclasses `SharedTexture`, implements `claim(): SharedTextureClaim`, and owns exclusive-claim concurrency control and native transport; Desktop Host is the provider. Consumers read `ctx.get('sharedTexture')`, which is absent in Hosts that do not present shared textures, and call `claim()` to obtain `capabilities(timeoutMs)`, `nativeSink(timeoutMs)`, `adapterLuid(timeoutMs)`, and `release()`. The Host entry's `apply` does nothing, because the Loader mounts the package only to deliver its Client half. Desktop Host provides the absolute path of the preinstalled receiver as `desktopFrameReceiver.path`.

### Client plugin (`@deepseek-ai/dsh-shared-texture/client`)

web-app mounts the Client plugin in every Web document. Where Desktop's product preload exposes `dshDesktop.textures`, the plugin provides that bridge as `ctx.sharedTexture` until it unloads; other documents get no service. Client plugins inject the service or read `ctx.get('sharedTexture')` and register their single `onFrame` consumer instead of reading host globals.

### Renderer types (`@deepseek-ai/dsh-shared-texture/types`)

Preload and main-process modules that compile under the Host TypeScript program import `SharedTextureClientExport` and `SharedTextureLease` from `@deepseek-ai/dsh-shared-texture/types`, and Client plugins import them from `./client`. `src/types.ts` declares no Cordis `Context`, so a program that must not see the Host service declaration can still use the renderer vocabulary; `SharedTextureHostExport` states the document global the Client plugin reads the export from.

### Configuration

The plugin accepts no configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`tsconfig.host.json` compiles `src/index.ts` and `src/types.ts`, and `tsconfig.client.json` compiles `src/types.ts` and `src/client/index.ts`. Each compiler face declares its own `Context.sharedTexture`, the abstract Host service or the Client export, so the two declarations never share a program. `tsdown.config.ts` emits the Host entry in the Host build pass, because Desktop Host extends `SharedTexture` at runtime, and the Client bundle `lib/client.js` in the Client pass.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host `SharedTexture` abstract service class, `SharedTextureClaim`, `SharedTextureService`, `SharedTextureCapabilities`, `SharedTextureNativeSink`, and the empty Host Loader entry |
| [`src/types.ts`](src/types.ts) | Cordis-free `SharedTextureClientExport`, `SharedTextureLease`, and `SharedTextureHostExport` types shared across Host, preload, and Client |
| [`src/client/index.ts`](src/client/index.ts) | Client plugin that provides `dshDesktop.textures` as `ctx.sharedTexture`, and the Client `Context.sharedTexture` declaration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Shared textures subsystem](../../../docs/subsystems/shared-texture.md) — generated Host Cordis API reference and lifecycle rules.
- [Desktop application](../../../apps/desktop/README.md) — Electron main/preload transport and native hop/ingress addons.

-----

<a id="model-experience"></a>
## Model Experience

None, as shared-texture service definitions and renderer bridge types add no model input.

#### KV Cache effect

None; this package neither assembles nor sends a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Host and Client `Context.sharedTexture` declarations do not guarantee availability; outside a host that provides shared textures, `ctx.get('sharedTexture')` returns `undefined`.
- `SharedTextureLease` exposes a DOM `VideoFrame`, so consumers of `./bridge` and `./client` must compile with DOM types.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
