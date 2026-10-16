---
description: "供用户与维护者在组合或调试可继续子级控制功能时使用的全局 send_message、interrupt_agent 与 list_agents 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-control` 提供可继续子级的全局控制工具：`send_message` 在父子或同级间发送 Steer 消息，`interrupt_agent` 停止后代当前轮次并保留收件箱和后代，可单独加载的 `list-agents` 插件按 id 和描述发现代理。父级与可继续子级继承相同的工具定义和顺序。

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
- name: '@deepseek-ai/dsh-tool-subagent-control'
- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

本包不接收任何配置：根插件提供 `send_message` 与 `interrupt_agent`，列表插件提供 `list_agents`。

### send_message

向 agent 的 `name` 发消息。确切在线的 Agent 可联系直接可继续子级；驻留的可继续子级还可联系直接父级或可继续同级。同级投递使用共同在线父级的权限，并保留实际发送方。工作中的目标通过 Steer 在最近步骤边界接收消息；不活跃的子级或同级会启动或恢复轮次。成功返回收件箱接受标识（`messageId`），而非回复。不支持的目标、不可用的父级、未知名字、缺失描述符或被拒绝的准入均返回错误。

### interrupt_agent

`name` 指定后代。外部执行永久停止，不能接收后续消息。本地目标只停止当前轮次：排队消息保留到后续 `send_message`，后代继续运行，子级仍可接受后续任务。调用在停止请求被接受时返回，不等待目标静止；中断已结束代理是成功的空操作，自身、同级、过期或非祖先调用方会收到错误。

### list_agents

按稳定前序列出全部可达的可继续后代，每行带直接父级名字 和深度。父级在线的可继续子代理先看到父级及可继续同级。在线状态为 `running` 或 `inactive`。外部条目无需读取子 Session 即被省略；可读的一次性子级用于遍历，但不输出行。未知模式和无法读取的子级目录产生诊断。普通 Session 分叉不是目录条目。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具把什么委托给 subagent 服务；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

工具先通过 `ctx.subagents.resolveName()` 解析名字，再调用 `sendMessage()` 或 `interrupt()`。驻留、冷恢复和授权属于服务。工具以确切在线的调用 Agent（`exec.agent`）作为发送方和权限凭据。

### 投递与信号所有权

工具转发执行信号，它只在收件箱接受前控制准入。已接受的消息不能通过此工具取消。每条消息以 `Agent <sender-name> sent a message:` 开头，并记录 `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`，使用父级权限的同级投递也一样。归属信息不授予权限。

### 列表投影

`list_agents` 无游标遍历调用方目录，并通过在线 Agent 注册表细化状态。可继续调用方的在线父级目录提供父级和同级行。后代遍历保留目录顺序；未知模式附带诊断并继续遍历，无法读取的目录则停止该分支。可达目录之外的后代无法被发现。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` 与 `interrupt_agent` 注册 |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` 注册：父级、同级与子级发现及状态细化 |

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

生成的 [schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)：`send_message` 接收 `name` 与 `message`；`interrupt_agent` 接收 `name`；`list_agents` 无参数。根名为 `lead`；描述可以重复。旧的无名 agent 使用稳定的 `legacy:<session-id>` 地址。

#### Token 影响

每个请求的模式成本固定，与子级数量或描述无关。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变，父级与其可继续子级（包括 fork 子级）收到相同的定义。

### 中断结果

#### 模型看到什么

接受后返回 `interrupt requested for agent <name>`。未知名字或未授权调用方（自身、同级、过期或非祖先）返回错误；已知且已结束的目标仍返回接受提示。

#### Token 影响

每次调用产生一条简短确认消息；被中断轮次的中止只在子级自己的 transcript（文本记录）中可见。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

### 投递结果

#### 模型看到什么

接受后返回 `message delivered to agent <name>`；规范输出携带已接受的 `messageId`。目标不在调用方支持的父级、子级或同级路由内，或准入被拒绝时，返回错误结果。

#### Token 影响

每次调用一条简短确认；目标回复不通过此调用返回。子级使用 `list_agents` 提供的父级和同级名字 发送后续消息。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 列表结果

#### 模型看到什么

每个后代按稳定顺序显示一行：`<id> [<status>] parent=<id> depth=<n> — <label>`。可继续子级的列表先显示 `<id> [<status>] — your parent`，再显示 `<id> [<status>] — sibling: <label>`。未知模式或无法读取的目录输出 `<id> [diagnostic: <reason>] parent=<id> depth=<n>`。状态描述轮次活动，不代表任务完成。`(no subagents)` 表示投影未留下任何行。

#### Token 影响

随列表行数线性增长，包含父级和同级行。没有游标或上限。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明控制工具无法观察或引导什么；它们是当前包约束。

- **已投递消息没有独立结果**——接受时只返回其 inbox `messageId`；目标后续工作会落入该目标的持久化会话，绝不会通过本工具收集。回复是另一条显式指定地址的 `send_message`，而非本次调用的结果。
- **消息要求在线谱系**——每个发送方可联系直接可继续子级。驻留的可继续子级在父级在线时还可联系直接父级和可继续同级。更深的后代与无关树不是消息目标；只有子级和同级投递支持冷激活。
- **列表是快照，而非投递承诺**——它可能与发布、dispose（资源释放）或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `inactive` 的子级；跨进程准确性需要共享租约。`interrupt_agent` 自己执行权威的在线 lineage 检查，因此过期的发现结果不会授予权限。
- **没有分页或删除**——系统返回完整且稳定排序的集合；只要子级会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
