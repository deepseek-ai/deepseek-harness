---
description: "面向用户与维护者的进程内 spawn subagent 后端说明，用于选择、配置或排查全新子级委派。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-spawn-in-process

[English](README.md) | 中文

## 概述

`dsh-subagent-spawn-in-process` 是一个进程内 subagent 后端：它在当前进程中运行每个委派任务，子 agent（智能体）是一个全新子 `Agent`，复用宿主的 agent 工厂及 LLM（大语言模型）/工具服务。子 agent 以空对话开始，因此任务提示词必须自足；除非 `request.agentOptions` 覆盖，否则它继承父 agent 的工作目录、会话谱系、提供方、模型、推理等级与输出 token 上限。委派工具或 API 调用以 `spawn` 提供方名称找到它。需要成本最低的委派传输时选择它；需要子 agent 建立在父级已完成对话轮次之上时，请选择 fork 后端。

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

在需要把工作委派给全新进程内子 agent 的组合中挂载此后端。常用路径是显式的：加载 subagent 服务与本后端，再把 `dsh-tool-subagent` 之类的委派工具指向 `spawn` 提供方。

### 何时选择

当子 agent 不需要父级对话、且可以接受在本进程内运行时，选择 spawn 后端。当子 agent 必须建立在已完成父级轮次之上时——fork 后端会提供这些历史——或必须在本进程之外运行时（进程外后端提供此能力），请避免使用它。由于子 agent 默认继承父级的工作目录与 LLM 选择，自足的提示词会按原样生效。

### 最小配置

先加载 subagent 服务与本后端，再为每个目标配置一个委派工具。这是暴露由 spawn 支撑的 `subagent` 工具的最小组合：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `spawn` | 注册到 `ctx.subagents` 的提供方名称 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-spawn-in-process)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 一次委派会做什么

一次工具调用启动一个子 agent 并等待其结果：子 agent 在自有会话中工作，父级只接收其最终输出；若运行被取消、拒绝、被 token 上限截断或在启动时被拒，则收到出错的工具结果。被拒绝的启动不会留下已发布的子 agent；完成的运行在结果收集后即被 dispose（资源释放）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端的构建方式以及[使用本包](#use-this-package)中行为的来源；共享机制属于进程内驱动器。

### 设计理念

一个分离：本后端只贡献提供方注册与「全新开始」的决定，其余全部运行机制——深度检查、子 agent 创建、按子 agent 定制、结构化输出、取消、结果读取与 dispose——都在 `dsh-subagent-in-process-driver` 中。agent 工厂的创建事务拥有未发布设置窗口及其回滚；发布之后，调用方拥有该运行。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方注册：`Config` schema、能力声明、`start()` |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

### 运行流程

启动请求先由 subagent 服务解析，然后共享驱动器校验深度、铸造子会话 id、通过宿主 agent 工厂以调用方信号创建子 agent、在创建窗口内应用 persona、工具过滤器与结构化输出、发布子 agent、驱动一项任务、读取子 agent 自身的最终输出，最后完全停稳地 dispose 句柄。

### 所有权与作用域

子 agent 获得全新的扁平注册作用域：父级工具限制与权限绝不会被导入，工具所施加的过滤属于组合而非父级派生授权。后端声明包括 `agentOptions` 在内的全部五项启动时能力，因为它控制子 agent 的创建窗口，可以逐一强制执行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享 subagent 模型进入兄弟后端与穷尽式配置。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——启动请求、结果、实时运行与提供方约定。
- [dsh-subagent-in-process-driver](../subagent-in-process-driver/README.zh.md)——本后端调用的共享运行驱动器。
- [dsh-subagent-fork-in-process](../subagent-fork-in-process/README.zh.md)——以已完成父级轮次作初始内容的兄弟后端。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——指向该提供方的面向模型委派工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-spawn-in-process)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

全新子 agent 逐字接收任务内容，作为新空对话中的唯一用户消息，默认使用父级提供方、模型、推理等级、输出 token 上限与工作目录。配置的 persona 会在子 agent 作用域中遮蔽全局提示词文本；工具过滤器会从其 schema、可执行工具查找与 PTC mode SDK 绑定中移除指定的全局工具，但保留独立注册的指导内容。不包含任何父级对话消息；过滤属于组合，而非继承的权限授予。

#### Token 影响

子 agent 为全新的独立上下文与历史支付 token，不复制任何父级历史 token。persona 会改变该子 agent 反复使用的提示词成本；工具过滤器会改变其 schema 或生成 SDK 的成本。

#### KV Cache 影响

子 agent 的请求缓存与父级相互独立。子 agent 历史仅追加；persona、工具过滤、生成 SDK、提供方或模型变化会建立不同的子 agent 前缀。

### 父级工具结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，父级只接收子 agent 的最终输出，或非完成终止原因对应的出错结果；子 agent 的中间工作绝不会到达父级。

#### Token 影响

父级输入增加一个取决于数据的结果，并保留到上下文压缩（context compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时选择该后端是错误的；它们是当前包约束。

- **全新表示不含父级 transcript（文本记录）**——子 agent 继承 cwd、谱系、提供方、模型、推理等级、输出 token 上限及显式配置的 persona/工具限制，但不继承父级的任何对话；需要已完成轮次上下文时，请使用 fork 后端。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
