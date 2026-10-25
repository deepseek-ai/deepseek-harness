---
description: "将可读的 subagent 名称绑定到 Session id，并从根 Session 恢复映射。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-names

[English](README.md) | 中文

## 概述

通过 `lead/research` 和 `lead/research/checker` 这样的可读名称寻址委派的 agent（智能体）。绑定名称在根 Session 重新加载后仍然保留，agent 执行结束后也保持原名称。委派工具需要名称，同时仍以 Session id 执行操作和检查授权时，可选择此包。未绑定名称的 agent 仍可通过 id 寻址。

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

在提供 `subagents` 和 `sessionProjections` 的组合中添加此配置项：

```yaml
- name: '@deepseek-ai/dsh-subagent-names'
```

此插件没有配置字段。它提供 `ctx.subagentNames`；subagent 服务负责执行、消息、发现和授权。

### 选择和查找名称

请求的名称段以小写字母开头，只能包含小写字母、数字、下划线和连字符。省略时，从 `agent-1` 开始选择父名称下第一个可用的 `agent-N`。预留可防止并发启动选择相同的完整名称。执行结算后，绑定名称仍被占用。

根名称为 `lead`。`nameOf` 返回已绑定的完整名称；没有绑定时，返回原 Session id。`resolveName` 接受 `lead` 和已绑定的完整名称；它拒绝未知的 `lead/...` 名称，并透传其他 id。后续 subagent 操作仍会对调用方进行授权检查。

### 启动后绑定

调用 `reserve(parent, requested?)`，通过 `ctx.subagents.startActivation` 启动子 agent，再根据成功回执调用 `bind(parent, childId, reservation.name)`。无论启动和绑定成功还是失败，都要在 `finally` 中调用 `dispose()` 释放预留。

绑定将完整名称记录到根 Session。若启动成功后绑定失败，调用方必须报告已启动的子 agent id；该子 agent 仍由 subagent 服务管理。绑定前崩溃也可能留下未命名的子 agent，它仍可通过 id 寻址。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

每个根 Session 保存自己的名称到 id 绑定。投影恢复这些绑定，并排除 fork 继承的记录。查询读取根映射，无需观察祖先 Session 或关联子 agent 目录。调用方拥有临时预留，并在操作后释放它们。

映射为每个具名子 agent 保留一条绑定：空间为 O(n)，单次查询或绑定为 O(n)；由于每个事件都会搜索绑定数组，回放 n 条不同绑定的最坏时间复杂度为 O(n²)。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 名称预留、绑定与查询 |
| [`src/projection.ts`](src/projection.ts) | 持久绑定与回放校验 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面负责执行行为以及使用名称的模型侧工具。

- [Subagent 服务](../subagent/README.zh.md) — 激活所有权、目录与授权。
- [委派工具](../tool-subagent/README.zh.md) — 命名创建与启动确认。
- [控制工具](../tool-subagent-control/README.zh.md) — 发现、消息与中断。
- [Session 投影](../../session/session-projection/README.zh.md) — 增量恢复。

-----

<a id="model-experience"></a>
## 模型体验

通过[委派工具](../tool-subagent/README.zh.md)和[控制工具](../tool-subagent-control/README.zh.md)间接影响模型；这些工具在 Session id 旁展示名称，并接受名称作为地址。

#### KV Cache 影响

此插件不添加提示词文本或工具 schema。消费方负责模型可见的名称文本及其缓存影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

名称绑定存在以下限制：

- **绑定后才可查询名称** — 子 agent 的首个请求可能早于绑定；此插件不添加初始身份消息。
- **名称不可变** — 激活结束后，绑定的名称和 id 也不能重新分配或复用。
- **路径采用预留时的父名称** — 未命名的父 agent 使用 `lead/legacy:<parentId>` 作为前缀；后续父级绑定不会改写子 agent 已存储的路径。
- **命名需要显式绑定** — 不绑定名称的调用方继续使用 Session id。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
