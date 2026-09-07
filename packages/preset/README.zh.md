---
description: "preset 组地图：按会话从 preset 文件组装 agent，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/preset

[English](README.md) | 中文

## 概述

preset 组提供按会话的 agent（智能体）组装：agent preset 是一个目录，内含一份 `agent.cordis.yml`；从 preset 组装的会话会运行该 preset 的工具、提示词段落与 skill（技能），而其他会话各自保持自己的。`agent-presets` 拥有名单——对已配置根目录与 harness home 的发现、受防护的按 agent 挂载，以及只复制的创作方式——`persona` 则提供可组装的行，让 preset 不止能改变 agent 的工具、也能改变它的身份。两者合起来让一个进程可以同时运行多个组装方式不同的 agent。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`agent-presets`](agent-presets/README.zh.md) | preset 名单、对受信任根目录与用户根目录的发现、按 agent 组装、只复制的创作 | `ctx.agentPresets` |
| [`persona`](persona/README.zh.md) | preset 挂载的可组装人设行，用于遮蔽或替换部署级人设 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [`AgentPresets` 参考](../../docs/subsystems/core.zh.md#ctxagentpresets--agentpresets)——发现、挂载、继承与重组。
- [Scope 子系统](../../docs/subsystems/scope.zh.md)——scope key 与挂载用以加入 agent 的父链。
- [系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)——preset 提示词段落如何注册与组装。
- [按会话组装 agent preset 的 Agent Note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.zh.md)——设计理由与备选方案。

部署交付的 preset 位于 [`agent-presets/presets/`](agent-presets/presets)——一个 preset 一个目录，那份目录列表就是名单；在这里再列一遍只会多出一份需要同步的名单。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
