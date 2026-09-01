---
description: "面向用户与维护者的进程内 fork subagent 后端说明，用于选择、配置或排查以父级已完成轮次作初始内容的子 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-fork-in-process

[English](README.md) | 中文

## 概述

`dsh-subagent-fork-in-process` 是一个进程内 subagent 后端：它以父级已完成的对话轮次作为每个子 agent（智能体）的初始内容——子 agent 能看到所有已完成轮次，但看不到进行中的轮次，因此后续工作可以在对话基础上继续，而无需复制对话。委派工具以 `fork` 提供方名称找到它，其行为与 spawn 后端一致，唯一差异是会话初始内容。当子任务延续当前对话时选择它；当子 agent 必须独立运行时选择 spawn。初始内容是 fork 时的一次性快照：此后父级记录的任何内容都不会到达子 agent。

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

当委派的工作必须建立在父级对话之上时，挂载此后端。常用路径与 spawn 相同：加载 subagent 服务与本后端，再把 `dsh-tool-subagent` 之类的委派工具指向 `fork` 提供方。

### 何时选择

当子 agent 需要对话的已完成轮次时——后续分析、审查、延续——选择 fork。当子 agent 应全新开始时选择 spawn；当子 agent 不能共享本进程时选择进程外后端。初始内容只传递对话历史：子 agent 仍获得全新的工具作用域，且不继承父级的任何权限。

### 初始内容边界

初始内容止于父级最后一个已完成的轮次。subagent 启动时，父级当前的工具调用轮次仍在进行，因此该进行中的轮次绝不会被包含；在第一个已完成轮次之前，初始内容为空，子 agent 的行为与全新 spawn 相同。

### 最小配置

先加载 subagent 服务与本后端，再配置一个委派工具。此组合暴露由 fork 支撑的 `subagent` 工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-fork-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `fork` | 注册到 `ctx.subagents` 的提供方名称 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-fork-in-process)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 一次 fork 委派会做什么

一次工具调用启动一个以已完成轮次为初始内容的子 agent，并等待其结果：子 agent 能看到截至父级最后一个已完成轮次的对话，在自有会话中工作，父级只接收其最终输出——取消、拒绝、token 上限截断或启动被拒时则收到出错的工具结果。初始内容在启动时只捕获一次；此后的父级轮次绝不会到达子 agent。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策，以及[使用本包](#use-this-package)中行为的来源。

### 设计理念

与 spawn 的差异只有一处，且以数据表达：后端计算父级日志的已配平已完成轮次前缀，并把它作为子 agent 的会话初始内容交给共享进程内驱动器。由于实时序号等于数组下标，前缀始终是自序号零开始的合法初始内容；驱动器记录其长度，使结果读取器不会把作为初始内容的父级消息误认为子 agent 输出。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方注册：前缀计算、`Config` schema、能力声明 |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

### 运行流程

`start` 时，从父级事件日志中截取截至最后一个 `turn/end` 的前缀；共享驱动器随后以该初始内容创建子 agent，应用相同的 persona、工具过滤器与结构化输出设置，驱动一项任务，读取子 agent 自身的最终输出，并完全停稳地 dispose。该提供方声明 `agentOptions`，以及与 spawn 相同的输出、深度、过滤与 persona 能力。`prepareContinuable` 在创建时只捕获一次前缀，因为它会成为子 agent 自身持久 transcript（文本记录）的一部分。

### 生命周期绑定

base bundle 与 ACP/headless 示例在委派工具上把本提供方绑定为 `backgroundMode: one-shot`，CLI preset 则选择 `continuable`。两者都保留继承的请求前缀：parent 与 child 获得定义和顺序相同的消息工具，可继续 child 的 parent id 与返回指导位于继承历史之后的初始用户任务中（见[保持 fork 缓存的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享 subagent 模型进入兄弟后端，以及一次性绑定的设计证据。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——启动请求、结果、提供方约定与进程内深度和初始内容。
- [dsh-subagent-in-process-driver](../subagent-in-process-driver/README.zh.md)——本后端调用的共享运行驱动器。
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.zh.md)——全新子级的兄弟后端。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——指向该提供方的面向模型委派工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-fork-in-process)——每个受支持配置字段及其源声明。
- [fork 保持 one-shot](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)——随附组合为何把 fork 绑定为 one-shot。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 历史与包络

#### 模型看到什么

子 agent 先接收由父级已配平的已完成轮次构成的前缀，再逐字接收新的任务内容。配置的 persona 会在子 agent 的全新作用域中遮蔽提示词文本；工具限制会过滤其全局协议 schema、可执行工具查找与 PTC mode SDK 绑定，但不影响独立指导内容。父级的工具视图与权限不会被继承；可选的结构化输出请求会添加仅属于子 agent 的约定；父级当前进行中的轮次会被排除。

#### Token 影响

fork 会把保留的已完成历史复制到子 agent 的请求中，子 agent 随后独立累积自己的 token。persona 会改变重复提示词的成本；过滤会改变 schema 或生成 SDK 的成本；首轮 fork 没有继承历史。

#### KV Cache 影响

在提供方与模型相同的前提下，子 agent 可以复用继承的逐字节相同前缀。persona、工具过滤、生成 SDK 或路由变化可能在继承历史之前使复用失效；后续子 agent 历史仅追加。可继续消息不增加 child 专属系统提示词 section 或工具 schema；parent id 与返回指导在初始用户任务中位于继承历史之后（见[保持 fork 缓存的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)）。

### 父级工具结果（间接）

#### 模型看到什么

父级只通过 `dsh-tool-subagent` 接收子 agent 自身的最终输出，不接收继承的前缀或中间工作。

#### Token 影响

父级输入增加一个取决于数据的最终结果，并保留到上下文压缩（context compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时选择该后端是错误的；它们是当前包约束。

- **初始内容是一次性快照**——子 agent 只能看到 fork 时父级已完成的轮次，看不到父级此后记录的任何内容；不会实时共享上下文。
- **fork 生命周期策略因组合而异**——base bundle 与 ACP/headless 示例使用一次性 fork，CLI preset 使用可继续 fork。两者都因 parent 与 child 消息定义逐字节相同而让继承前缀保持可复用；显式 persona、工具过滤、生成 SDK 或路由变化仍可破坏相等性。理由见[保持 fork 缓存的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)。
- **随附 fork 工具不公开子级 LLM 路由选择**——它们继承父级提供方与模型，使复制的历史仍有资格复用 KV Cache。在某项改动能保留复用或公开有界重算成本前，路由选择保持禁用；[模型选择路由 Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.zh.md)说明这项限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
