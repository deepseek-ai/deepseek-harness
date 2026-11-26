# 共享纹理

[English](shared-texture.md) | 中文

共享纹理 seam 将 GPU 帧从 Host 进程传递到展示文档，无需经由 JavaScript 复制像素。[`@deepseek-ai/dsh-shared-texture`](../../packages/shared-texture/shared-texture/README.zh.md) 定义抽象 Host Cordis 服务 `SharedTexture`、把渲染端导出提供为 `ctx.sharedTexture` 的 Client 插件，以及渲染端类型（`SharedTextureClientExport`、`SharedTextureHostExport`、`SharedTextureLease`）。

## Host 与 Client 入口

| 入口 | 导出 | 职责 |
|---|---|---|
| `@deepseek-ai/dsh-shared-texture` | `SharedTexture`、`SharedTextureClaim`、`SharedTextureService`、`SharedTextureCapabilities`、`SharedTextureNativeSink`、`apply` | 抽象 Host 侧 `ctx.sharedTexture` 服务，由呈现宿主（例如 Desktop Host）继承；提供方负责独占认领的并发控制与原生传输，入口的 `apply` 不做任何事。 |
| `@deepseek-ai/dsh-shared-texture/types` | `SharedTextureClientExport`、`SharedTextureHostExport`、`SharedTextureLease` | 无 Cordis 依赖的渲染端类型，供在看不到 Host 服务声明的程序中编译的 preload 与 IPC 模块使用。 |
| `@deepseek-ai/dsh-shared-texture/client` | `apply`、`SharedTextureClientExport`、`SharedTextureHostExport`、`SharedTextureLease` | 由 web-app 挂载的 Client 插件；它把 Desktop 的 `dshDesktop.textures` 提供为 `ctx.sharedTexture`，在其他文档中不提供任何服务。 |

[Desktop 应用](../../apps/desktop/README.zh.md)拥有 Electron 传输、原生 addon 及 preload 桥接。Desktop Main 编译时使用 Desktop Host 导出的控制消息类型（[`apps/desktop-host/src/types.ts`](../../apps/desktop-host/src/types.ts)），因此公开发布的包只承载 seam；两侧各自在运行时校验收到的每条消息。在未提供共享纹理的宿主中，Host 与 Client 两侧的 `ctx.get('sharedTexture')` 均返回 `undefined`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
