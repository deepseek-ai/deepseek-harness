---
description: "用于选择并注册一个桌面提供方的计算机操作能力包。"
kind: "package-group"
---

# packages/computer-use

[English](README.md) | 中文

## 概述

计算机操作提供方让模型观察并操作桌面。本组负责提供方的独占注册。各提供方拥有自己的操作、工具和平台要求；实验性 Cua Driver 提供方位于 experimental 组。

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
- [实验性包](../experimental/README.zh.md) — Cua Driver MCP 和原生提供方。

<a id="dev-note"></a>
## 开发备注

无。
