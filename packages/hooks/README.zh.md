---
description: "hooks 组地图：在 agent（智能体）运行期间使用现有的 Claude Code 与 Codex shell 钩子配置，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/hooks

[English](README.md) | 中文

## 概述

hooks 组让 agent 运行可以复用为 Claude Code 或 Codex 编写的 shell 钩子。把对应集成指向现有的 `hooks.json`，即可在会话开始、提示词到达、工具运行或运行停止时执行受支持的 command hook。这些钩子可以用模型可见消息阻止提示词或工具调用、向对话添加上下文，或要求运行继续。当你需要保留现有钩子配置时，选择本组；每项集成只支持其来源工具所记录的 command hook 子集。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | 形态 |
|---|---|---|
| [`hook-protocol`](hook-protocol/README.zh.md) | 两个桥接共享的钩子引擎；不得直接配置 | 库 |
| [`hooks-claude-code`](hooks-claude-code/README.zh.md) | 在 agent 运行期间运行你现有的 Claude Code `hooks.json` 钩子 | 插件 |
| [`hooks-codex`](hooks-codex/README.zh.md) | 在 agent 运行期间运行你现有的 Codex `hooks.json` 钩子 | 插件 |

-----

<a id="related-documentation"></a>
## 相关文档

- [拦截扩展点 Agent Note](../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.zh.md)——桥接所面向的类型化 Decision 接口面。
- [钩子桥接 Agent Note](../../.agents/notes/archived/feature/2026-06-30-hook-bridges.md)——桥接设计及其决策映射。
- [钩子协议库 Agent Note](../../.agents/notes/archived/feature/2026-06-30-hook-protocol-lib.md)——共享库负责的内容及其原因。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
