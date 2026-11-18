---
description: "用于选择并注册一个桌面提供方的计算机操作能力包。"
kind: "package-group"
---

# packages/computer-use

[English](README.md) | 中文

## 概述

计算机操作提供方让模型观察并操作桌面。本组包含共享注册器，防止同一组合同时启用多个提供方。DSH 的 [CUA 实现](../experimental/cua/README.zh.md)、平台提供方和启用组合包目前位于 `experimental`，Cua Driver 适配包也位于该组。CUA 包文档说明了迁入本组所需的平台支持条件。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

选择一个提供方并挂载共享注册服务。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`computer-use`](computer-use/README.zh.md) | 按名称独占注册提供方 | `ctx.computerUse` |

<a id="related-documentation"></a>
## 相关文档

- [计算机操作](../../docs/subsystems/computer-use.zh.md) — 能力归属和提供方选择。
- [Computer Use 组合包](../experimental/cua-bundle/README.zh.md)：启用原生 CUA 并使用权限管理功能。
- [实验性包](../experimental/README.zh.md)：原生 CUA 包和 Cua Driver 适配包。

<a id="dev-note"></a>
## 开发备注

无。
