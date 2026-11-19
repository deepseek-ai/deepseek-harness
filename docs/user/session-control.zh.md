---
description: "在 Web profile 中启用跨 Session 消息，并理解独立对话的接收回执。"
---

# 向另一个 Session 发送消息

[English](session-control.md) | 中文

## 概述

当 Agent 需要向另一个普通 Session 发送指令或发现时，在 Web profile 中启用 `session_send_message`。接收方可以属于其他 Workspace 或目录。你需要一个包含 `@deepseek-ai/dsh-web-app` bundle 的 profile（例如 `web`），以及目标 Session 的 id。`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 中没有该工具。

## 目录

- [启用消息](#enable-messaging)
- [发送并检查回执](#send-and-check-the-receipt)
- [投递限制](#delivery-limits)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="enable-messaging"></a>
## 启用消息

该工具默认关闭。启用后，任何能看到它的 Agent（包括 subagent）都可以向 Web Session 控制器能打开的任意普通 Session 发消息，包括当前 Workspace 或 cwd 之外的 Session。

将以下 patch 追加到某个 Web profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，保留已有条目。未设置 `DSH_HOME` 时使用 `~/.dsh`：

```yaml
- id: tool-session-control
  disabled: false
```

修改 patch 后重启 profile。该 patch 指向 Web bundle 中的 `tool-session-control` 行。`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 没有这一行，因此 Loader 在这些 profile 中会警告找不到该条目并跳过此 patch。

在源码 checkout 中，同一 patch 位于 [session-control.overlay.yml](../../apps/cli/config/examples/session-control.overlay.yml)。无需启动 Web 服务器即可检查其效果：

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/session-control.overlay.yml --dump-config
```

合成后的 `tool-session-control` 行具有 `disabled: false`。启动该 profile 时保留此 overlay，或将 patch 保留在上面的 profile 文件中。[Profile 参考](../../apps/cli/README.zh.md#profiles)说明 patch 优先级和配置检查方式。

<a id="send-and-check-the-receipt"></a>
## 发送并检查回执

工具描述要求 Agent 仅在你明确要求它向另一个 Session 发消息时使用该工具。向它提供目标 Session id 和要发送的消息。例如，请它使用以下参数调用 `session_send_message`：

```json
{
  "session_id": "target-session-id",
  "message": "Please review the latest test results and send me your findings."
}
```

将占位符替换为调用方自身之外的真实 Session id。消息必须包含非空白文本。接收方记录的发送者是调用方 Session；工具不接受发送者覆盖参数。

成功结果包含 `message_id`。它确认消息已进入收件箱，不等待回复或任务完成。目标取消或释放可能使消息未被处理。运行中的接收方在下一次可接收输入时获得 steer 输入；空闲接收方开始一轮；不在线的接收方先恢复对话再接收消息，之后像在 Web UI 中打开的 Session 一样保持加载。

<a id="delivery-limits"></a>
## 投递限制

- 已归档 Session 拒绝消息并保持归档状态。发送前需显式取消目标的归档。
- subagent 目标对 `session_send_message` 不可用，因此普通 Session 无法用它回复发送消息的 subagent。只有调用方自身 subagent 树内的成员才能使用 `send_message` 访问。
- 自动回复可能反复唤醒两个 Session 并消耗 token。仅在用户明确要求时使用的指令依赖模型遵循；运行时不限制消息发送速率或转发跳数。
- 接收前的取消会阻止投递。接收后的取消可能返回 `ABORTED`，但不会撤回消息。取消后或结果未知时不要自动重复发送。
- 该工具只发送文本。它不等待接收方回答，也不与另一个 Harness 进程通信。

<a id="further-exploration"></a>
## 进一步探索

- [Session 控制工具](../../packages/session/tool-session-control/README.zh.md) — 工具参数、失败和呈现。
- [API Session Controller](../../packages/api/session-controller/README.zh.md) — Web profile 中的 Session 激活与恢复。

<a id="dev-note"></a>
## 开发备注

无。
