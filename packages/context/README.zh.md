---
description: "context 组地图：不定义工具、为每次请求添加持久且模型可见上下文的插件，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# context/ — 请求上下文插件

[English](README.md) | 中文

## 概述

context 组提供不定义任何工具、为每次请求添加模型可见上下文的插件：工作区指令文件成为指引，`@file` mention 提供路径补全，其他会话可以作为有界快照被引用，模型还能看到当前时间与 agent 的 tmux 位置。除 `agent-instructions`（`dsh-base` 默认包含它，profile patch 可以禁用）外，其余全部需主动启用。上下文是持久的：注入的指令与引用以 user 角色消息进入会话历史，因此与其他对话内容一样持久、可回放、可压缩。本页是组的映射；包级约定由各包 README 负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`agent-instructions/`](agent-instructions/README.zh.md) | 将 `AGENTS.md`／`CLAUDE.md` 工作区指令加载到上下文，并在文件编辑后刷新 | — |
| [`session-reference/`](session-reference/README.zh.md) | 引用其他会话：提及一个会话，其有界只读快照即成为上下文 | `ctx.sessionReferenceResolver` |
| [`file-reference/`](file-reference/README.zh.md) | `@file` mention 发现与供宿主驱动 UI 使用的共享 mention 语法 | `ctx.fileReferences` |
| [`file-reference-local/`](file-reference-local/README.zh.md) | `@file` mention 的本地工作区补全提供方 | — |
| [`time-context/`](time-context/README.zh.md) | 每个步骤的当前时间、浏览器时区与经过时长 | — |
| [`tmux-context/`](tmux-context/README.zh.md) | agent 所在的 tmux session、window 与 pane 位置 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [会话引用子系统](../../docs/subsystems/session-reference.zh.md)——规范 mention URI、快照语义与稳定的错误分类。
- [工作区上下文决策记录](../../.agents/notes/archived/feature/2026-06-24-workspace-context.md)——指令上下文为何按 agent／会话隔离并持久记录。
- [生成的配置目录](../../docs/config-catalog.zh.md)——本组各包接受的全部配置字段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
