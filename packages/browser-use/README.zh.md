---
description: "浏览器操作能力包，用于选择与注册一个浏览器后端。"
kind: "package-group"
---

# packages/browser-use

[English](README.md) | 中文

## 概述

浏览器操作 提供方 让模型检查与操作网页。本组拥有独占 提供方 注册。实验性 提供方 提供浏览器工具，并管理各 Session 的浏览器资源。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

选择一个 提供方 并挂载共享注册服务。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`browser-use`](browser-use/README.zh.md) | 独占具名 提供方 注册 | `ctx.browserUse` |

<a id="related-documentation"></a>
## 相关文档

- [浏览器操作](../../docs/subsystems/browser-use.zh.md) — 能力所有权与 提供方 选择。
- [实验包](../experimental/README.zh.md) — Playwright MCP、Chrome DevTools MCP 与 Stagehand 提供方。

<a id="dev-note"></a>
## 开发备注

无。
