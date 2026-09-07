---
description: "hooks 组地图：在 agent 运行期间使用现有的 Claude Code 与 Codex shell 钩子配置，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/hooks

[English](README.md) | 中文

## 概述

hooks 组让 agent（智能体）运行可以使用你为 Claude Code 或 Codex 写好的 shell 钩子：挂载对应的桥接、把它指向你现有的 `hooks.json`，这些钩子就会在 agent 运行中的对应时刻触发——会话开始时、提示词提交时、工具运行前后，或运行即将停止时。钩子可以带一条模型可见的消息阻塞提示词或工具调用、向对话附加额外上下文，或强制运行继续。当你希望现有钩子配置无需改写成原生插件就能继续工作时，选择本组；每个桥接覆盖其参考工具文档中的 command hook 子集。`hook-protocol` 是两个桥接共享的钩子引擎，因此两种方言在协议一致之处行为相同。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | 形态 |
|---|---|---|
| [`hook-protocol`](hook-protocol/README.zh.md) | 两个桥接共享的钩子引擎；无需直接配置 | 库 |
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
