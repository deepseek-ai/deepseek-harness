---
description: "会话压缩（compaction）功能家族的包映射：自动压缩、按需 /compact 命令与工具输出修剪。"
kind: "package-group"
---

# compaction/ — 压缩能力家族

[English](README.md) | 中文

## 概述

`compaction/` 组让长时 agent（智能体）会话在接近模型上下文上限时仍能正常工作：token 压力上升时自动把较早历史压缩为摘要，可用 `/compact` 按需压缩，超大工具输出也可以先被修剪，从而减少需要压缩的内容，支持图片的路由发不出的图片则被替换为占位文本。随附 `dsh` 基础配置默认启用该功能。显式挂载各包即可调整压缩发生的时机与方式。决定何时压缩的 token 测量属于独立的 LLM（大语言模型）家族服务。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

以下每个包提供该功能的一个环节；打开对应包页面了解如何使用。

| 包 | 职责 | ctx key |
|---|---|---|
| [`compaction/`](compaction/README.zh.md) | 共享的压缩约定：所有后端与触发器使用的操作与摘要格式 | `ctx.compaction` |
| [`compaction-basic/`](compaction-basic/README.zh.md) | 随 token 压力上升自动把较早历史压缩为摘要 | 注册 `ctx.compaction` |
| [`compaction-tool-result-pruner/`](compaction-tool-result-pruner/README.zh.md) | 修剪超大工具输出，减少需要压缩的历史 | `ctx.toolResultPruner` |
| [`compaction-image-offload/`](compaction-image-offload/README.zh.md) | 支持图片的路由拒绝请求时，把超出预算的请求图片替换为占位文本 | 监听 `agent/request-error` |
| [`command-compact/`](command-compact/README.zh.md) | 按需压缩历史的 `/compact` 命令 | 注册到 `ctx.commands` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解共享词汇，再阅读两份 Agent Note 了解设计依据。

- [压缩子系统参考](../../docs/subsystems/compaction.zh.md)——压缩词汇、结果与服务行为。
- [压缩能力 seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md)——家族如何拆分，以及为何依赖会话与 LLM 词汇。
- [排队手动压缩 Agent Note](../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.zh.md)——按需 `/compact` 如何与运行中的轮次串行化。
- [能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)——本家族遵循的 Service Definition / Service Provider / Consumer 拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
