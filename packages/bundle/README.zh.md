---
description: "共享核心、浏览器 GUI、一次性任务、ACP（Agent Client Protocol）与 SDK 应用表层的现成 dsh profile 组合包。"
kind: "package-group"
---

# bundle/：profile 插件组合包

[English](README.md) | 中文

## 概述

本组列出 `dsh --profile` 使用的可安装 patch 层。每个包都声明 `dsh.bundle.patch`；启动器会叠放这些 patch 文档来组装具名 profile。`web`、`headless`、`acp` 与 `sdk` profile 以 `dsh-base` 为基础，`sdk-minimal` 则由一个组合包提供完整配置树。领域包也可以在本目录之外声明附加层。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`base`](base/README.zh.md) | 基于 base 的 profile 共享核心 | —（仅 patch） |
| [`acp-app`](acp-app/README.zh.md) | 基于 base、仅用于自动化的 ACP stdio 应用 | 挂载 ACP bridge |
| [`web-app`](web-app/README.zh.md) | 基于 base 的浏览器应用层 | 挂载多条 Web 配置行 |
| [`headless`](headless/README.zh.md) | 基于 base 的一次性命令行任务应用 | `headless-runner` |
| [`sdk-app`](sdk-app/README.zh.md) | 基于 base 的 SDK JSON-RPC stdio 应用 | 挂载 SDK 服务器 |
| [`sdk-minimal`](sdk-minimal/README.zh.md) | 不使用 base 或 Web 的独立极简 SDK 应用 | —（完整 patch 树） |

内置组合包从 dsh 安装目录解析；树外（out-of-tree）组合包通过 `dsh plugin --profile <name> add <package>` 安装进 profile。

<a id="related-documentation"></a>
## 相关文档

- [dsh 应用](../../apps/cli/README.zh.md)——启动 profile 的 `dsh` 命令。
- [app-boot](../boot/app-boot/README.zh.md)——profile 如何解析、分层与定制。
- [Profile 插件组合包设计笔记](../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与组合包的组合设计。
- [生成组合图](../../apps/cli/composition.md)——每个随发行版交付的 profile 使用的确切组合。

<a id="dev-note"></a>
## 开发备注

无。
