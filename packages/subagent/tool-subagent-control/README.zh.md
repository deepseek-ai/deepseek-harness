---
description: "全局 send_message、interrupt_agent 与 list_agents 工具，供用户与维护者组合或排查可继续子级的控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-control` 为可继续子级添加全局控制工具：`send_message` 在直接 parent 与 child 之间 steer，`interrupt_agent` 停止 child 当前轮次但保留其 inbox 与后代，`list_agents`（来自可单独加载的 `list-agents` 插件）按持久化 id 与标签列出可继续 child。parent 与可继续 child 继承相同的 `send_message` 定义和顺序，因此模型通信不会增加 child 专属工具 schema。是否加载这些工具不会决定委派工具是否启动可继续工作。

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

在模型需要对可继续子级发消息、中断或列出的任何组合中挂载本包。根插件只需要 subagent 服务；列表工具是独立插件，部署方可以省略。

### 最小配置

先加载 subagent 服务、一个后端、委派工具与本包。加上独立的列表插件即可公开全部三个工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    backgroundMode: continuable
- name: '@deepseek-ai/dsh-tool-subagent-control'
- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

本包不接收任何配置：根插件提供 `send_message` 与 `interrupt_agent`，列表插件提供 `list_agents`。

### send_message

向 `agent_id` 指定的 Agent 发送消息：任何确切在线 Agent 都可以指定自己的直接可继续 child，而驻留的可继续 child 还可以指定自己的直接 parent。正在工作的目标通过 Steer 在最近的 step 边界接收消息；空闲目标会启动一个轮次，冷状态的直接 child 会通过继续执行生命周期恢复。调用只返回接受结果（被接受消息的稳定 `messageId`），绝不返回回复。失败——不受支持的目标、不可用的 parent、未知 child、缺少描述符而无法恢复的 child，或准入被拒——会明确说明消息未送达。

### interrupt_agent

只停止目标当前轮次：已排队消息保持暂停直到之后的 `send_message`，后代继续运行，子级仍可接受后续消息。调用在停止请求被接受后立即返回，不等待目标完全停稳；中断已结束的 agent 是被接受的 no-op，而 self、sibling、陈旧与非 ancestor 调用方会收到出错结果。

### list_agents

列出调用 agent 下方的可继续子级：`children`（默认）只显示直接子级，`descendants` 按稳定 pre-order 遍历整棵树，并为每个条目标注其持久化直接父级会话 id 与深度。状态来自在线 Agent 注册表——`running`、`idle` 或 `ready`。一次性子级因无法接受 `send_message` 而被有意排除，无法读取的候选项以 diagnostic 呈现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具把什么委托给 subagent 服务；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

`ctx.subagents.sendMessage()`、`interrupt()` 与列表投影之上的轻量适配器；工具不执行任何生命周期路由。驻留、冷恢复与授权归服务所有，工具把确切在线的调用 Agent（`exec.agent`）同时作为 sender 与权限凭据传入。

### 投递与信号所有权

工具转发其执行信号，该信号只在 inbox 接受之前掌管准入。目标一旦接受消息，该消息便无法再通过本工具取消。每条消息都以 `Agent <sender-id> sent a message:` 作为前缀，并记录 `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`；该来源信息由服务推导，且绝不被视为权限。

### 列表投影

`list_agents` 从调用 agent 推导根 id，不使用 cursor 读取服务目录，通过在线 Agent 注册表细化每个候选的状态，并省略无法接受 `send_message` 的一次性子级。diagnostic 在 descendants scope 中保留其位置，且绝不暴露描述符内容。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` 与 `interrupt_agent` 注册 |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` 注册：作用域、状态细化、投影 |
| — | 不发布运行时不变式伴生入口；这个模型侧 adapter 没有独立 lifecycle stream；delivery 与 activation 关系由 subagent service 负责。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从工具 schema 进入其背后的继续执行服务。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——可继续子级、Activation、inbox、中断与后续消息权限。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——启动可继续子级的委派工具。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)——三个工具的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

已生成的 [schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)：`send_message` 接受 `agent_id` 与 `message`；`interrupt_agent` 接受 `agent_id`；`list_agents` 接受可选的 `scope` 枚举。

#### Token 影响

每个父级请求支付固定的 schema 成本。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变。

### 中断结果

#### 模型看到什么

接受时返回 `interrupt requested for agent <agent_id>`。未授权的调用方——self、sibling、陈旧或非 ancestor——会成为指明拒绝原因的出错结果；目标不存在或已结算仍渲染接受行。

#### Token 影响

每次调用产生一条简短确认消息；被中断轮次的中止只在子级自己的 transcript 中可见。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

### 投递结果

#### 模型看到什么

接受时返回 `message delivered to agent <agent_id>`；规范输出携带被接受的 `messageId`。失败——非相邻目标、不可用的 parent、未知 child、缺少描述符而无法恢复的 child，或准入被拒——会成为出错的结果，其消息说明该消息未送达。

#### Token 影响

每次调用产生一条简短确认消息；目标的响应绝不会通过本次调用返回。child 使用同一个工具和初始任务中的 parent id，把选定内容追加到 parent 历史中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 列表结果

#### 模型看到什么

按稳定目录顺序，每个可继续子级占一行：`<id> [<status>] — <label>`（`running` 表示 driver 活跃，`idle` 表示驻留但处于轮次之间，`ready` 表示仅存于存储，可恢复而非终态），另为无法读取的候选项渲染 `<id> [diagnostic: <reason>]`。`descendants` scope 会在每行 label 破折号之前按 pre-order 插入 ` parent=<id> depth=<n>`。一次性子级会被有意排除；`(no subagents)` 表示投影后没有留下可继续子级或 diagnostic。

#### Token 影响

随所列可继续子级数量线性增长——`descendants` scope 下为整棵树；没有 cursor 或上限，因此长期存活且有许多持久化子级的父级每次调用都会承担完整列表成本。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明控制工具无法观察或引导什么；它们是当前包约束。

- **已投递消息没有独立结果**——接受时只返回其 inbox `messageId`；目标后续工作会落入该目标的持久化会话，绝不会通过本工具收集。回复是另一条显式指定地址的 `send_message`，而非本次调用的结果。
- **只有受支持的相邻 Agent 可以通信**——每个 sender 都可以指定直接可继续 child，只有具备驻留可继续 Activation 的 sender 可以指定自己的直接 parent，且该 parent 必须仍在线；sibling 与更深的后代不能作为消息目标，只有直接 child 投递支持冷激活。
- **列表是快照，而非投递承诺**——它可能与发布、dispose（资源释放）或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `ready` 的子级；跨进程准确性需要共享租约。`interrupt_agent` 自己执行权威的在线 lineage 检查，因此过期的发现结果不会授予权限。
- **没有分页或删除**——系统返回完整且稳定排序的集合；只要子级会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
