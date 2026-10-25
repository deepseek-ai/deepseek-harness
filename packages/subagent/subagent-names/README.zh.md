---
description: "为 subagent 创建持久的同级名称，并为委派工具解析其树路径，同时保留 Session 身份。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-names

[English](README.md) | 中文

## 概述

为委派的 agent（智能体）赋予 `lead/research` 和 `lead/research/checker` 这样的可读名称。名称在 Session 重新加载后仍然保留，查询也能读取已不在运行中的父 agent。需要命名委派工具，同时保留 Session id 用于执行和授权时，可选择此包。名称标识目录中已有的子 agent；创建失败不会永久占用所请求的名称。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此插件与支持命名的[委派工具](../tool-subagent/README.zh.md)和[控制工具](../tool-subagent-control/README.zh.md)一起挂载。

### 最小配置

在提供 `agents`、`subagents` 和 `sessionProjections` 的组合中添加此配置项：

```yaml
- name: '@deepseek-ai/dsh-subagent-names'
```

此插件没有配置字段。它提供 `ctx.subagentNames`；现有 subagent 服务继续负责提供方、激活、消息和授权。名称查询和发现所需的父级读取要求挂载 `sessionQuery`；为根启动子 agent 以及读取根名称不需要它。

### 选择和查找名称

请求的同级名称以小写字母开头，只能包含小写字母、数字、下划线和连字符。省略名称时，从 `agent-1` 开始选择第一个可用的 `agent-N` 名称。名称不可变，且在直属父 agent 下唯一，并发启动也遵守此规则。已提交的子 agent 在执行结算后仍保留其名称。

运行中树的根名称为 `lead`；子路径按父级逐段追加。目录中未命名的子 agent 使用 `legacy:<sessionId>` 作为路径段。查询接受完整的 `lead/...` 路径、`lead`，或树成员的确切 Session id，包括现有运行时通知中的 id。查询只解析身份；后续 subagent 操作仍会对调用方进行授权检查。

### 创建与失败

调用 `ctx.subagentNames.startActivation` 时使用 `delivery: 'parent'`，让现有目录保留子 agent 身份。需要由调用方接收结果时，使用 `ctx.subagents.startActivation`；该操作保留基于 id 的行为。

本地创建会在启动子 agent 前记录候选名称。只有现有父目录记录该子 agent 后，名称才可被发现。创建失败或崩溃遗留的候选记录，只要其子 agent 不在目录中，就既不可解析，也不占用名称。目录包含子 agent 后，即使启动随后失败，也不会释放其名称。

外部提供方分配自己的 id，因此在启动返回后才记录名称。如果记录失败，操作会尝试并等待 dispose（资源释放），然后报告已启动的子 agent id。已完成的外部工作无法撤销；若 dispose 也失败，执行可能仍在继续。重试前请检查该子 agent。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

插件拥有父级本地的名称记录，并将其与现有 subagent 目录关联。其投影排除 fork 继承的记录。待提交的同级名称预留属于插件实例；卸载时会先取消并等待进行中的命名启动，再释放其状态。

名称读取通过 Session 观察沿创建祖先关系遍历，无需恢复父 agent。发现操作为 subagent 服务已有的后代条目附加相对路径。投影缺失或目录与名称记录不一致时会明确失败，不会提供未经确认的别名。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 命名启动、预留生命周期、路径查询与发现 |
| [`src/projection.ts`](src/projection.ts) | 持久候选记录与回放校验 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面负责执行行为以及使用名称的模型侧消费方。

- [Subagent 服务](../subagent/README.zh.md) — 激活所有权、目录与授权。
- [委派工具](../tool-subagent/README.zh.md) — 命名创建与启动确认。
- [控制工具](../tool-subagent-control/README.zh.md) — 发现、消息与中断。
- [Session 投影](../../session/session-projection/README.zh.md) — 增量恢复与观察。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 初始身份

#### 模型看到什么

命名启动会在任务提示词后加入子 agent 及其父 agent 的完整名称。本地子 agent 在持久的初始用户消息中接收此文本；外部提供方在委派提示词中接收它。根下名为 `research` 的子 agent 会收到：

##### 身份消息

```markdown
Your name is "lead/research". Your parent agent name is "lead".
```

#### Token 影响

每个命名子 agent 的初始提示词增加一条简短的身份句；祖先路径越长，路径文本越多。此插件不注册工具 schema 或系统提示词段落。

#### KV Cache 影响

身份文本作为新任务提示词的一部分，位于继承历史之后。已有历史保持不变；每个子 agent 接收各自的身份文本。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

名称在现有执行身份之外提供补充，并存在以下限制：

- **直接调用 subagent 服务的创建仍未命名** — 绕过 `ctx.subagentNames` 的启动使用 `legacy:<sessionId>` 路径表示。
- **外部名称绑定发生在执行启动之后** — 记录失败时，外部工作可能已经开始或完成。
- **运行时通知保留 Session id** — 名称不会改写由 subagent 服务负责的消息或结算通知。
- **目录中的子 agent 不可改名或复用名称** — 激活结算或 dispose 不会移除其持久目录成员记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
