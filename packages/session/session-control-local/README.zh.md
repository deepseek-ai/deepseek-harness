---
description: "向当前运行时中的独立 Session 投递 Agent 消息，使用记录的预设恢复冷 Session，并保留部署的模型默认值。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-control-local

[English](README.md) | 中文

## 概述

向当前运行时中在线或已持久化的独立 Session 发送消息。冷 Session 使用记录的预设恢复；未选择模型的 Session 跟随部署的当前默认值。已归档目标会拒绝消息，不会被取消归档。Subagent Session 继续通过现有树内控制操作。

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

[基础 bundle](../../bundle/base/README.zh.md) 为 [Session 控制服务](../session-control/README.zh.md) 挂载此提供方。自定义组合需要 `sessionControl`、`agents`、`sessions`、`sessionQuery` 和 `agentDefaultModel`；持久化目标还需要 Agent 工厂和持久化服务。可选的预设注册表恢复已记录预设，可选的 Workspace 注册表提供归档状态。此提供方没有配置字段。

通过 `ctx.sessionControl.sendMessage` 或其[模型工具](../tool-session-control/README.zh.md) 发送消息。精确的在线 Agent 可以向此运行时可见的任意独立 Session 发送消息，包括不同 Workspace 或 cwd 中的 Session；该授权不借用 API Remote principal。运行中的接收方接受 steer 输入，在下一次可接收输入时处理；空闲接收方开始一轮。冷恢复保留历史，回执确认收件箱已接受消息，无需等待回答。

Session 缺失、目标已归档、身份由 subagent 拥有、另有写入者以及恢复失败都会返回结构化失败。取消在接受前生效。卸载此提供方时，先取消并等待其调用结束，再释放它恢复的 Agent 句柄；原本在线的 Agent 仍由原创建者拥有。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[提供方](src/index.ts) 在接受输入前重新检查调用者身份、目标归档状态及目标所有权。它通过 Session 查询服务保留冷观察结果，并读取其中投影的预设。其 `compose`、`defaultOptions`、`presetForObservation` 和 `resumeObserved` 方法为 [API Session Controller](../../api/session-controller/README.zh.md) 提供普通 Session 激活；控制器保留自身 Remote 错误与空 Session 复用规则。`resumeObserved` 将返回的句柄绑定到调用方 Context；消息投递恢复的句柄由此提供方拥有。异步预设解析后会再次检查 subagent 所有权。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session 控制](../session-control/README.zh.md) — 署名、顺序和接受回执。
- [Session 查询](../../session-query/session-query/README.zh.md) — 保留的观察结果。
- [Agent 预设](../../preset/agent-preset-registry/README.zh.md) — 记录的组合与默认组合。
- [Subagent 服务](../../subagent/subagent/README.zh.md) — 托管子 Agent 的继续执行。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话

#### 模型看到什么

接收方沿用已有 Session 历史，并收到 [Session 控制](../session-control/README.zh.md#model-experience) 所述带署名的 Agent 消息。冷恢复重新应用记录的 `agentPreset`；普通提示词和工具仍由该预设拥有。

#### Token 影响

恢复保留对话已有历史，并加入已接受消息。此提供方不贡献单独的模型指令或 schema。

#### KV Cache 影响

在线投递追加输入，不重写较早上下文。恢复的 Agent 从记录的历史和所选预设重建请求；缓存复用取决于最终请求和模型提供方。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此提供方面向当前运行时的 Session 存储与持久化服务，不向另一个正在运行的 Harness 实例投递。
- Subagent Session 需要现有树所有者并遵守继续执行规则。普通 Session 恢复不能绕过这些要求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
