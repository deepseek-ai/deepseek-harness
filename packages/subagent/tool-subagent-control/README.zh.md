---
description: "通过消息、中断和收件箱等待发现并协调 subagent 树。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-control` 让 agent（智能体）按 Session id 发现和联系其 subagent（子智能体）树、中断后代，并等待自身下一步收件箱。默认情况下，一个插件实例注册全部四个工具；成员继承相同定义和顺序。

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

每个工具作用域挂载一次此包。它需要 `tools`、`subagents`、`agents` 和 `systemPrompt`。

### 最小配置

所需服务可用后，加载 subagent 服务、一个后端、委派工具和此包，即可提供全部四个控制与发现工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
```

设置 `config.interrupt: false` 可省略 `interrupt_agent`。默认值为 `true`。其余三个工具和 `ctx.subagents.interrupt()` 仍然可用。参见生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-subagent-control)。

### send_message

通过 `agent_id` 向同一 subagent 树中的另一个 agent 发送消息。调用方必须是在线根代理或驻留的可继续子代理。工作中的目标在下一步接收 Steer 输入；不活跃目标开始或恢复一个轮次。只恢复目标，其创建祖先保持离线。成功返回收件箱接受结果（`messageId`），不返回回复。自身、无关树、不支持的目标、未知 id、不可用历史和被拒绝的输入都会返回错误。

### interrupt_agent

`agent_id` 使用 Session id 指定后代。外部执行永久停止，不能接收后续消息。本地目标只停止当前轮次：排队消息保留到后续 `send_message`，后代继续运行，子级仍可接受后续任务。调用在停止请求被接受时返回，不等待目标静止；中断已结束代理是成功的空操作，自身、同级、过期或非祖先调用方会收到错误。

<a id="wait_agent"></a>
### wait_agent

等待当前调用者的下一步收件箱。已有待处理输入时立即返回；之后到达的输入，包括消息、完成通知和用户引导，会结束等待。排队的下一轮消息、其他收件箱和 Agent 状态变化不会结束等待。任务变化不会结束等待。工具既不消费输入，也不启动 Agent。`timeout_ms` 默认为 30000，必须是 10000 至 3600000 的整数。结果仅含 `timedOut`；取消、调用者释放或插件卸载会拒绝等待。

### list_agents

按稳定前序列出根与所有可达的可继续后代，包括调用方。后代行包含直接父级 id 与相对根的深度。在线状态为 `running` 或 `inactive`。外部条目被省略，且不读取其子 Session；可读的一次性子级仍作为遍历节点。未知模式与不可读目录产生诊断。普通 Session 分叉形成独立的 subagent 树。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具把什么委托给 subagent 服务；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

通信、中断和发现委派给 `ctx.subagents`；驻留、冷恢复和授权属于该服务。等待工具在启动定时器并检查待处理下一步输入前订阅当前调用者的收件箱事件，并在每次结束时移除监听器和定时器。

### 投递与信号所有权

执行信号只负责收件箱接受前的工作。已接受的消息不能通过此工具撤回。每条消息以 `Agent <sender-id> sent a message:` 为前缀，并记录 `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`。树成员身份授予通信权限；subagent 树根管理运行时实例和容量。

### 列表投影

`list_agents` 解析调用方的在线根，从根开始无游标遍历目录，并通过在线 Agent 注册表细化活动状态。未知模式附带诊断并继续遍历；不可读目录停止对应分支。可达目录之外的 Session 无法被发现。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 共享控制工具注册 |
| [`src/list-agents.ts`](src/list-agents.ts) | 整棵 subagent 树的发现与活动投影 |
| [`src/wait-agent.ts`](src/wait-agent.ts) | 当前调用者的收件箱等待和清理 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从工具 schema 进入其背后的继续执行服务。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——可继续子级、Activation、inbox、中断与后续消息权限。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——启动可继续子级的委派工具。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)——工具 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

生成的 [schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control) 定义按 id 寻址的通信与中断、整树发现，以及带 `timeout_ms` 的收件箱等待。`wait_agent` 在输入可用时返回 `{ "timedOut": false }`，超时时返回 `{ "timedOut": true }`。它不返回消息正文或其他成员活动诊断。

#### Token 影响

每个请求的模式成本固定，与子级数量或描述无关；关闭中断会移除其 schema 和发现指引。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变，父级与其可继续子级（包括 fork 子级）收到相同的定义。

### 身份与通信上下文

#### 模型看到什么

必需的 `subagent:identity` 运行时上下文通过 Session id 标识每个 agent。委派子级会被明确标识为 subagent，并收到直接父级和根级 id。该上下文独立于 Team 模式和工具过滤；活动根缺失时会明确报告，但不阻止独立工作。活动根可用时，身份上下文会分别根据标准工具的获准情况提供通信与发现指引。自动结果交付仍由 subagent 服务负责。

#### Token 影响

每个 agent 接收一条简短上下文，长度与树规模无关。

#### KV Cache 影响

身份与通信指引作为持久记录的运行时上下文位于继承历史之后，共享系统提示词和工具定义不变。设置 `includeRuntimeContext: false` 后，该必需上下文仍会提供，并会在压缩后恢复。Team 模式不会改变它。

### 中断结果

#### 模型看到什么

接受时返回 `interrupt requested for agent <agent_id>`。未授权的调用方——self、sibling、陈旧或非 ancestor——会成为指明拒绝原因的出错结果；目标不存在或已结算仍渲染接受行。

#### Token 影响

每次调用产生一条简短确认消息；被中断轮次的中止只在子级自己的 transcript（文本记录）中可见。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

### 投递结果

#### 模型看到什么

接受时返回 `message delivered to agent <id>`；规范输出携带已接受的 `messageId`。目标不属于调用方的 subagent 树或输入被拒绝时，返回错误结果。

#### Token 影响

每次调用返回一条简短确认；回复通过单独指定收件人的消息到达。使用 `list_agents` 中的 id 向 subagent 树内成员发送后续消息。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 列表结果

#### 模型看到什么

首行为 `<id> [<status>] — root agent`。各可继续后代随后显示为 `<id> [<status>] parent=<id> depth=<n> — <label>`。根使用 `kind: root`；后代相对该根使用 `kind: child`。诊断显示为 `<id> [diagnostic: <reason>] parent=<id> depth=<n>`。状态描述轮次活动，不表示任务完成、成功或失败。

#### Token 影响

随整棵 subagent 树列出的行数线性增长。没有游标或上限。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明控制工具无法观察或引导什么；它们是当前包约束。

- **已投递消息没有独立结果**——接受时只返回其 inbox `messageId`；目标后续工作会落入该目标的持久化会话，绝不会通过本工具收集。回复是另一条显式指定地址的 `send_message`，而非本次调用的结果。
- **消息需要在线 subagent 树根**——中间创建者可以离线。仅恢复目标，占用一个共享容量名额。无关树、外部目标与一次性目标不能接收消息。
- **列表是快照，而非投递承诺**——它可能与发布、dispose（资源释放）或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `inactive` 的子级；跨进程准确性需要共享租约。`interrupt_agent` 自己执行权威的在线 lineage 检查，因此过期的发现结果不会授予权限。
- **没有分页或删除**——系统返回完整且稳定排序的集合；只要子级会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
