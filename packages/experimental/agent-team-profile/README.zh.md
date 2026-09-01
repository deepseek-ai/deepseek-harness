---
description: "叠加在 dsh-base 上的私有 Agent Teams profile 层，供源码 checkout 用户使用 Team-scoped 协作工具，同时保留一次性 delegation。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team-profile` 是在 `@deepseek-ai/dsh-base` 之上启用 [Agent Teams](../agent-team/README.zh.md) 的私有 profile 层。它的 patch 会插入 Team domain 与 Team-scoped 工具、禁用名称重叠的全局 continuable-child control，并保留普通的一次性 fresh 与 fork delegation 工具。必须将本包显式添加到已初始化的源码 checkout profile；正式发布会排除本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

在本仓库 checkout 中，将本包添加到已初始化的 profile，然后运行一个要求 Lead 委派工作的任务：

```sh
pnpm dsh plugin --profile headless add ./packages/experimental/agent-team-profile
pnpm dsh --profile headless "Use Agent Teams to split this task between two teammates, wait, and summarize."
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层会使用其中的 Subagent service 与 provider 配置行。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` 移除本包时，bundle 也会从 profile 的有序层列表中移除。

### 获得的功能

本层会添加 Agent Teams domain，以及 Team-scoped 创建、roster、消息、interrupt、等待与任务板工具。它会禁用工具名与 Team control 重叠的全局 continuable-child control 行，同时保留 `subagent` 与 `subagent_fork` 作为一次性 delegation 工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-base` 之后应用时，patch 会禁用 `tool-subagent-control` 与 `tool-subagent-list-agents`，把 fresh 与 fork Subagent 行设置为 `one-shot`，并以显式 provider 和限制插入 Team service 与工具行。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| — | 不发布运行时不变式伴生入口；本包是静态 bundle，不持有可独立观察的运行时关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布排除规则。
- [Agent Teams service](../agent-team/README.zh.md)——持久 roster、消息与任务板行为。
- [Agent Teams 工具](../tool-agent-team/README.zh.md)——Team-scoped 模型工具表层。
- [Base bundle](../../bundle/base/README.zh.md)——本 patch 扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型会看到什么

Team 策略与 schema 由 [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.zh.md) 所有。本 bundle 只改变 composition：Team-scoped `list_agents`、`send_message` 与 `interrupt_agent` 会替代已禁用的全局 continuable-child control。`subagent` 与 `subagent_fork` 仍作为一次性 delegation 工具可用，其子 agent 不会获得 continuable-child `report` 工具。

#### Token 影响

本 bundle 会加入 `dsh-tool-team` 描述的 Team 策略与工具 schema；它自身不增加提示词文本。

#### KV Cache 影响

只要 bundle patch、Team identity 与配置的工具 schema 不变，本 bundle 的 composition 就保持前缀稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限源码 checkout**——正式 npm、CLI、Web 与 Python 发布产物都不包含这个私有包。
- **共享 checkout**——所有 teammate 都观察同一个工作目录；本 bundle 不提供 worktree 隔离或文件系统锁。
- **需要 base profile**——本 patch 依赖 `dsh-base` 提供的配置行 id 与 Subagent provider；它不是独立 profile。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
