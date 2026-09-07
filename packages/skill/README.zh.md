---
description: "skill 组地图：由提供方发现、并经会话目录与 skill 工具加载的可复用 agent 指令，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# skill/ — skill（技能）能力家族

[English](README.md) | 中文

## 概述

skill 组让 agent（智能体）和用户按需使用可复用的任务专项指令。提供方贡献 skill——来自本地项目或用户目录、随包分发或远程服务——注册表合并它们的目录，并为每个名称解析出胜出的 skill。一个消费方把可用 skill 发布为持久的会话目录，并提供面向模型的 `skill` 加载工具，因此模型看到排序后的 skill 名称与简短描述，并能加载任一列出 skill 的完整指令；用户也可以用 `/name` 直接调用 skill。提供方类型不会改变模型看到的内容，因为所有面向模型的渲染都集中在一个消费方包中。按需挂载各包：注册表加至少一个提供方，再加消费方以获得模型访问。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`skill/`](skill/README.zh.md) | 合并任意提供方的 skill 目录、并按名称解析出胜出 skill 的注册表 | `ctx.skills` |
| [`skill-filesystem/`](skill-filesystem/README.zh.md) | 从项目、自定义与用户目录发现 skill，并监视其变更 | 注册到 `ctx.skills` |
| [`skill-badge/`](skill-badge/README.zh.md) | 随包附带官方「powered by dsh」徽章 skill，默认禁用 | 注册到 `ctx.skills` |
| [`tool-skill/`](tool-skill/README.zh.md) | 发布会话 skill 目录与面向模型的 `skill` 加载工具 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解共享词汇，再阅读 Agent Note 了解设计依据。

- [skill 子系统参考](../../docs/subsystems/skills.zh.md)——注册表、提供方约定、本地发现优先级，以及目录与工具。
- [skill 调用策略 Agent Note](../../.agents/notes/implemented/feature/2026-07-28-skill-invocation-policy.zh.md)——模型与用户调用控制。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
