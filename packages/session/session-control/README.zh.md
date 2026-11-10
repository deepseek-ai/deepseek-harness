---
description: "向 Session 发送带真实 Agent 署名的消息，并获取其收件箱接受标识。共享投递保留取消、目标顺序和 subagent 生命周期所有权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-control

[English](README.md) | 中文

## 概述

向一个 Session 发送消息，无需等待回复即可获取接受回执。每条消息都标明实际发送它的 Agent。运行中的接收方获得 steer 输入，空闲接收方开始一轮；投递提供方在支持时恢复冷接收方。现有 subagent 消息保留树内权限和恢复规则。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

通过 `ctx.sessionControl.sendMessage({ id, message }, { caller, signal })` 向独立 Session 发送非空白文本。可信调用方提供精确的在线 Agent 和取消信号；模型参数不能替换发送者。返回的 `messageId` 标识已接受的收件箱消息，不表示回复或已完成的轮次。[模型工具](../tool-session-control/README.zh.md) 提供 JSON 接口。

[基础 bundle](../../bundle/base/README.zh.md) 挂载本服务及其[本地提供方](../session-control-local/README.zh.md)。自定义组合需要 Agent 注册表和投递提供方；本服务没有配置字段。Subagent 消费方使用现有 [subagent 服务](../../subagent/subagent/README.zh.md)，由它解析名称并保留树内权限。

取消会停止接受前的工作，绝不撤回已经接受的消息。移除提供方会取消并等待其待处理调用结束，之后才能注册替代提供方。调用不会自动重试，包括投递结果未知的失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[服务](src/index.ts) 按目标 Session id 串行处理独立 Session 和 subagent 两个入口的投递。[消息构造函数](src/message.ts) 在投递前固定消息标识和真实发送者。提供方保留恢复、关闭协调、归档检查和最终收件箱准入的所有权。Subagent 管理器注册其现有私有投递能力，因此关闭和父级汇报记账仍由该管理器负责。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [本地 Session 控制](../session-control-local/README.zh.md) — 当前运行时中的恢复与投递。
- [Session 控制工具](../tool-session-control/README.zh.md) — 面向模型的参数与回执。
- [Subagent 服务](../../subagent/subagent/README.zh.md) — 树成员身份与继续执行。

-----

<a id="model-experience"></a>
## 模型体验

### Agent 消息

#### 模型看到什么

接收方收到 `Agent <sender> sent a message: `，其后跟随发送者的内容。独立 Session 消息使用发送者的 Session id；subagent 消息在名称可用时使用树内名称。同一条持久消息记录 `source.kind: 'agent-message'` 和真实的 `senderSessionId`。

#### Token 影响

每条已接受消息都会把署名前缀和提供的内容加入接收方输入。本服务自身不添加工具 schema 或常驻提示词。

#### KV Cache 影响

投递向接收方已有对话追加输入，不替换较早的消息或系统提示词。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 接受回执不报告执行成功、完成或回复。需要结果的调用方必须使用单独的对话或结果读取操作。
- 回执标识不对独立调用去重。调用方不得仅因操作结果未知就重复操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
