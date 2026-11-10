---
description: "以调用智能体的真实身份向其他会话发送消息，无需等待回复即可获得接收回执。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-control

[English](README.md) | 中文

## 概述

向其他独立会话发送消息，并在对方接收后继续工作。运行中的接收方会在下一次接收输入时读取消息；空闲接收方会开始一轮执行，离线接收方会先恢复。接收方看到的发送者是实际调用工具的智能体。会话控制提供方仍会执行访问和归档限制。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `tools`、`sessionControl` 和一个会话控制提供方一同挂载。本工具没有配置字段。调用 `session_send_message({ session_id: "target-id", message: "Please review the result." })` 可获得 `{ "message_id": "accepted-message-id" }`。

```yaml
- name: '@deepseek-ai/dsh-tool-session-control'
```

没有调用智能体时，工具抛出 `ToolContextUnavailableError`（`TOOL_CONTEXT_UNAVAILABLE`）；消息只有空白字符时，抛出 `ToolArgsError`（`INVALID_ARGS`）。提供方失败会保留结构化错误码。取消只会停止接收前的工作，不会撤回已经接收的消息。已归档目标保持归档并拒绝投递。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

工具将运行时的实际调用智能体和取消信号传给[会话控制](../session-control/README.zh.md)，由该服务负责授权、恢复、发送者归属和投递。Host 展示器显示目标和消息；Web 工具卡片从已记录的结果中推导接收状态和消息 ID。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话控制](../session-control/README.zh.md) — 共享投递与提供方注册。
- [本地会话控制](../session-control-local/README.zh.md) — 访问、恢复和生命周期规则。
- [工具](../../core/tools/README.zh.md) — 调用、取消和结果记录。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 Schema 与结果

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-control)定义确切 schema。回执确认消息已被接收，不表示执行完成或对方已回复。Schema 不提供发送者身份或权限覆盖参数。

#### Token 影响

工具可用时，其 Schema 会占用提示词 Token。每次调用会追加参数和精简的 JSON 接收回执；接收方通过共享服务获得消息。

#### KV Cache 影响

工具可用性会改变 Schema 上下文。调用和回执追加到常规历史中，不会改写之前的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 消息仅包含文本；工具不附加文件，也不等待接收方完成执行。
- 在结果未知时，接收回执不意味着可以安全重试。调用方必须保留已知成功的回执。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
