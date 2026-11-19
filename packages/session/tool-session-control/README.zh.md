---
description: "在 Web profile 中启用 session_send_message，让 Agent 向另一个普通会话发送消息，并在不等待回复的情况下获得接收回执。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-control

[English](README.md) | 中文

## 概述

让 Web profile 中的 Agent 向另一个普通会话发送消息（包括位于其他 Workspace 或目录的会话），并在接收方接收后继续工作。运行中的接收方会在下一个输入边界读取消息；空闲接收方会开始一轮执行，不在线的接收方会先恢复。接收方看到的发送者是调用方会话。本工具默认关闭，只存在于 Web 组合中，且从不等待回复；subagent 目标对本工具不可用。

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

通过 profile patch 启用 `@deepseek-ai/dsh-web-app` bundle 中处于禁用状态的 `tool-session-control` 行；[用户指南](../../../docs/user/session-control.zh.md)给出该 patch 以及检查合成后该行的方法。

### 何时选择

当 Web profile 中的 Agent 需要把指令或发现交给独立会话时启用本工具。本工具不施加 Workspace 或目录限制：任何能看到它的 Agent（包括 subagent）都可以向 Session 控制器能解析的任意普通会话发送消息。若 Agent 不应在其他会话中启动工作，请保持该行禁用。同一 subagent 树的成员之间改用 [subagent 控制](../../subagent/tool-subagent-control/README.zh.md)提供的 `send_message` 通信。

### 最小配置

```yaml
- id: tool-session-control
  disabled: false
```

本包不声明 `Config` 字段。它注入 `ctx.tools`、来自 [`@deepseek-ai/dsh-api-session-controller`](../../api/session-controller/README.zh.md) 的 `ctx.sessionController`，以及来自 [`@deepseek-ai/dsh-workspace`](../../workspace/workspace/README.zh.md) 的 `ctx.workspaceRegistry`；dsh-web-app bundle 会挂载这两个 Host 服务，缺少它们的组合不会注册本工具。

### 投递与失败

调用 `session_send_message({ session_id: "target-id", message: "Please review the result." })` 可获得 `{ "message_id": "accepted-message-id" }`。回执确认目标收件箱已将该消息作为 steer 输入接收，不表示接收方已经运行或回复。工具通过 `ctx.sessionController.resolveAgent()` 解析目标：复用在线 Agent，并发调用方共享同一次冷恢复，Session 控制器会像对待在 GUI 中打开的会话一样让恢复出的 Agent 保持驻留。

| 条件 | 结果 |
|---|---|
| 没有调用智能体 | `ToolContextUnavailableError`（`TOOL_CONTEXT_UNAVAILABLE`） |
| 消息只有空白字符 | `ToolArgsError`（`INVALID_ARGS`），在激活之前 |
| 目标是调用方自己的会话 | `SESSION_MESSAGE_SELF` |
| 目标在激活前或激活后已归档 | `SESSION_MESSAGE_ARCHIVED`；目标保持归档 |
| 目标归 subagent 路由所有 | `SESSION_MESSAGE_SUBAGENT_OWNED`；目标对本工具不可用 |
| 其他 Session 控制器失败，包括未知会话或没有工作目录的会话 | 控制器的 `RemoteError` 错误码，例如 `session/not-found` 或 `session/writer-held` |

`SESSION_MESSAGE_*` 失败均为 `SessionMessageError` 实例，在目标收件箱接收消息之前抛出。接收前的取消会使调用失败并立即停止等待；已在进行的恢复会在 Session 控制器下继续，工具在取消后不会投递任何内容。接收后的取消可能返回 `ABORTED`，即使消息已经送达。取消不会撤回已接收的输入，也不能证明消息未送达。工具从不自动重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

工具从运行时的调用智能体获取发送者，因此模型无法选择发送者身份。它先检查 Workspace 注册表的归档列表，在与调用方取消信号竞争的同时等待 Session 控制器完成激活，随后再次检查取消状态和归档列表。它使用 `@deepseek-ai/dsh-subagent` 声明的 `agent-message` 来源构造消息，记录调用方的 `senderSessionId`，在正文前加上 `Session <caller session id> sent a message: ` 前缀，然后对目标调用 `steer()`。该前缀不同于 `send_message` 的 `Agent <name> sent a message: `：后者的名称只能在同一棵 subagent 树内解析。收件箱失败原样传播。[工具流水线](../../core/tools/README.zh.md)沿用普通取消行为。Host 展示器显示目标 id 和消息正文；[Web 工具卡片](../../client/ui-tool/README.zh.md)从已记录的结果中推导接收状态和消息 ID。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具定义、失败码、归档检查与激活等待 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [向另一个 Session 发送消息](../../../docs/user/session-control.zh.md) — 在 Web profile 中启用本工具。
- [API Session Controller](../../api/session-controller/README.zh.md) — 会话激活、恢复与所有权。
- [subagent 控制](../../subagent/tool-subagent-control/README.zh.md) — subagent 树内的 `send_message`。
- [工具](../../core/tools/README.zh.md) — 调用、取消和结果记录。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 Schema 与结果

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-control)定义确切 schema。描述向模型发出指令："Use this tool only when the user explicitly asks you to send a message to another session." Schema 既不提供发送者身份，也不提供权限覆盖参数。成功调用返回一个 JSON 文本块 `{"message_id":"..."}`，确认消息已入队，不表示执行完成或对方已回复。目标取消或释放可能使消息未被处理。被拒绝的调用返回 `Error: <message>`；subagent 目标的消息为 `session "<id>" is not available to session_send_message`。

#### Token 影响

工具可见时，其 Schema 会占用提示词 Token。每次调用会向调用方历史追加参数和精简回执。

#### KV Cache 影响

启用或禁用该行会改变工具 Schema 列表，并可能从第一个发生变化的 Schema token 起使缓存复用失效。调用和回执追加到常规历史中，不会改写之前的消息。

### 投递的消息

#### 模型看到什么

接收方收到一条 steer 用户消息：文本块 `Session <caller session id> sent a message: `，后接原样保留的消息正文。

#### Token 影响

接收方历史增加该前缀和消息正文。

#### KV Cache 影响

在接收方只追加；消息在其下一个输入边界加入，不会改写之前的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限 Web 组合** — 只有 dsh-web-app bundle 声明该行；`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 不挂载 Session 控制器，也不提供 `session_send_message`。
- **subagent 目标不可用** — subagent 可以向普通 Session 发消息，但该 Session 无法通过本工具回复它。独立的 `send_message` 工具只能访问调用方自身 subagent 树内的成员。
- **自动回复循环** — 自动回复可能反复唤醒两个 Session 并消耗 token。仅在用户明确要求时使用的指令依赖模型遵循；运行时不限制消息发送速率或转发跳数。
- **仅文本，不等待回复** — 消息只包含文本；工具不附加文件，也不等待接收方的轮次或回答。
- **恢复出的 Agent 保持驻留** — 为投递消息而冷恢复的目标会在 Session 控制器下保持加载，与在 GUI 中打开的会话相同。
- **结果未知时不可安全重试** — 接收不具备幂等性；调用方必须保留已知成功的回执，且不得自动重复发送。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
