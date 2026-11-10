---
description: "启用跨 Session 消息，并理解同一 Harness 运行时中独立对话的接收回执。"
---

# 向另一个 Session 发送消息

[English](session-control.md) | 中文

## 概述

当 Agent 需要向另一个独立 Session 发送指令或发现时，启用 `session_send_message`。接收方可以属于其他 Workspace 或目录。两个 Session 必须对同一 Harness 运行时可见。你需要一个已配置且使用 base bundle 的 profile（例如 `web`），以及目标 Session 的 id。

## 目录

- [启用消息](#enable-messaging)
- [发送并检查回执](#send-and-check-the-receipt)
- [投递限制](#delivery-limits)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="enable-messaging"></a>
## 启用消息

该工具默认关闭。启用后，调用 Agent 可以向运行时可见的任意独立 Session 发消息，包括当前 Workspace 或 cwd 之外的 Session。

将以下 patch 追加到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，保留已有条目。未设置 `DSH_HOME` 时使用 `~/.dsh`：

```yaml
- id: tool-session-control
  disabled: false
```

修改 patch 后重启 profile。此示例要求 profile 包含 base bundle；`sdk-minimal` 不包含该 bundle。

在源码 checkout 中，同一 patch 位于 [session-control.overlay.yml](../../apps/cli/config/examples/session-control.overlay.yml)。无需启动 Web 服务器即可检查其效果：

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/session-control.overlay.yml --dump-config
```

合成后的 `tool-session-control` 行具有 `disabled: false`。启动该 profile 时保留此 overlay，或将 patch 保留在上面的 profile 文件中。[Profile 参考](../../apps/cli/README.zh.md#profiles)说明 patch 优先级和配置检查方式。

<a id="send-and-check-the-receipt"></a>
## 发送并检查回执

向 Agent 提供目标 Session id 和要发送的消息。例如，请它使用以下参数调用 `session_send_message`：

```json
{
  "session_id": "target-session-id",
  "message": "Please review the latest test results and send me your findings."
}
```

将占位符替换为真实的独立 Session id。消息必须包含非空白文本。接收方记录的发送者是调用 Agent；工具不接受发送者覆盖参数。

成功结果包含 `message_id`。它确认收件箱已接收消息，不等待回复或任务完成。运行中的接收方在下一次可接收输入时获得 steer 输入；空闲接收方开始一轮；冷接收方先恢复对话再接收消息。

<a id="delivery-limits"></a>
## 投递限制

- 已归档 Session 拒绝消息并保持归档状态。发送前需显式取消目标的归档。
- subagent 目标使用现有 `send_message` 工具及其树内名称和权限。`session_send_message` 不会绕过 subagent 恢复规则。
- 取消可阻止尚未接收的消息进入收件箱，不会撤回已接收的消息。保留成功回执；结果未知时不要自动重复发送。
- 该工具发送文本，不等待接收方回答，也不与另一个 Harness 进程通信。

<a id="further-exploration"></a>
## 进一步探索

- [Session 控制工具](../../packages/session/tool-session-control/README.zh.md) — 工具参数、结果和呈现。
- [本地 Session 控制](../../packages/session/session-control-local/README.zh.md) — 恢复、访问和提供方生命周期。

<a id="dev-note"></a>
## 开发备注

无。
