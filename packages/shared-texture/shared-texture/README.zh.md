---
description: "Host 与 Client 共享纹理 Cordis 服务（ctx.sharedTexture）及纯渲染器桥接类型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-shared-texture

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-shared-texture`，插件可以通过 `ctx.sharedTexture` 呈现或接收共享 GPU 帧，而不依赖 Electron 或 Desktop 的内部实现。Host 入口定义抽象服务 `SharedTexture`，由呈现宿主（例如 Desktop Host）继承，提供独占认领（`claim()`）。Client 半边是一个插件，把宿主壳提供的 `SharedTextureClientExport` 提供为 Client 侧的 `ctx.sharedTexture`；preload 与 IPC 模块从不含 Cordis 声明的 `./types` 子路径导入这些渲染端类型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### Host 服务（`@deepseek-ai/dsh-shared-texture`）

呈现宿主继承 `SharedTexture` 并实现 `claim(): SharedTextureClaim`，自行负责独占认领的并发控制与原生传输；目前的提供方是 Desktop Host。消费方通过 `ctx.get('sharedTexture')` 读取服务（不呈现共享纹理的 Host 中没有这个服务），再调用 `claim()` 获取 `capabilities(timeoutMs)`、`nativeSink(timeoutMs)`、`adapterLuid(timeoutMs)` 与 `release()`。Host 入口的 `apply` 什么也不做，因为 Loader 挂载本包只是为了送出它的 Client 半边。Desktop Host 通过 `desktopFrameReceiver.path` 提供预装接收器的绝对路径。

### Client 插件（`@deepseek-ai/dsh-shared-texture/client`）

web-app 在每个 Web 文档中挂载这个 Client 插件。Desktop 的产品 preload 暴露 `dshDesktop.textures` 时，插件把这个桥接提供为 `ctx.sharedTexture`，直到插件卸载；其他文档中没有这个服务。Client 插件注入该服务或读取 `ctx.get('sharedTexture')`，并注册唯一的 `onFrame` 消费者，不再读取宿主全局变量。

### 渲染端类型（`@deepseek-ai/dsh-shared-texture/types`）

在 Host TypeScript 程序下编译的 preload 与主进程模块从 `@deepseek-ai/dsh-shared-texture/types` 导入 `SharedTextureClientExport` 和 `SharedTextureLease`，Client 插件则从 `./client` 导入。`src/types.ts` 不声明任何 Cordis `Context`，因此不能看到 Host 服务声明的程序也能使用这套渲染端词汇；`SharedTextureHostExport` 描述 Client 插件读取该导出的文档全局。

### 配置

本插件不接受配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`tsconfig.host.json` 编译 `src/index.ts` 与 `src/types.ts`，`tsconfig.client.json` 编译 `src/types.ts` 与 `src/client/index.ts`。两个编译面各自声明自己的 `Context.sharedTexture`：Host 侧是抽象服务，Client 侧是渲染端导出，因此两份声明不会出现在同一个程序里。`tsdown.config.ts` 在 Host 构建阶段产出 Host 入口，因为 Desktop Host 在运行时继承 `SharedTexture`；Client 构建阶段产出 Client bundle `lib/client.js`。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 侧 `SharedTexture` 抽象服务类、`SharedTextureClaim`、`SharedTextureService`、`SharedTextureCapabilities`、`SharedTextureNativeSink`，以及空的 Host Loader 入口 |
| [`src/types.ts`](src/types.ts) | Host、preload 与 Client 共用的无 Cordis 依赖 `SharedTextureClientExport`、`SharedTextureLease` 与 `SharedTextureHostExport` 类型 |
| [`src/client/index.ts`](src/client/index.ts) | 把 `dshDesktop.textures` 提供为 `ctx.sharedTexture` 的 Client 插件，以及 Client 侧的 `Context.sharedTexture` 声明 |

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

- [共享纹理子系统](../../../docs/subsystems/shared-texture.zh.md) — 生成的 Host Cordis API 参考与生命周期规则。
- [Desktop 应用](../../../apps/desktop/README.zh.md) — Electron 主进程／preload 传输与原生 hop／ingress addon。

-----

<a id="model-experience"></a>
## 模型体验

无，因为共享纹理服务定义和渲染器桥接类型不增加任何模型输入。

#### KV Cache 影响

无；本包既不组装也不发送模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- Host 与 Client 的 `Context.sharedTexture` 声明不保证服务一定存在；在未提供共享纹理的宿主中，`ctx.get('sharedTexture')` 返回 `undefined`。
- `SharedTextureLease` 暴露 DOM `VideoFrame`，因此 `./bridge` 与 `./client` 的消费方必须包含 DOM 类型编译。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
