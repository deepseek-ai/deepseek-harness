---
description: "共享纹理能力 seam：抽象的 Host Cordis 服务、提供渲染器桥接的 Client 插件，以及桥接类型。"
kind: "package-group"
---

# packages/shared-texture

[English](README.md) | 中文

## 概述

共享纹理把 GPU 帧从 Host 进程传递到展示文档，无需通过 JavaScript 复制像素。本组定义 Host 侧 `ctx.sharedTexture` 抽象服务、把渲染器桥接提供为 Client 侧 `ctx.sharedTexture` 的 Client 插件，以及供 Host、preload 和浏览器插件共用的纯渲染器桥接类型。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`shared-texture`](shared-texture/README.zh.md) | 抽象的 Host 共享纹理服务、Client 桥接插件及渲染器桥接类型 | `ctx.sharedTexture` |

<a id="related-documentation"></a>
## 相关文档

- [共享纹理](../../docs/subsystems/shared-texture.zh.md) — Host 独占认领生命周期、渲染器桥接类型与 Cordis API。
- [Desktop 应用](../../apps/desktop/README.zh.md) — Electron 传输、原生 addon 与 preload 桥接实现。

<a id="dev-note"></a>
## 开发备注

无。
