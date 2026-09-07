# Agent Note: 反馈确认中的会话共享披露

Status: implemented
Archived: 2026-09-04

[English](2026-08-07-feedback-acknowledgement-sharing-disclosure.md) | 中文

## 问题

`/feedback` 命令会记录一个仅写入日志的 `feedback/record` 事件并确认用户，但确认文本没有携带关于会话去向的持久信息：挂载了会话遥测（`FULL`、`FEEDBACK_ONLY` 或 `DISABLED`）的部署无法告知用户其反馈和会话是否离开了进程，确认文本也没有回显接收会话的 id。命令插件无法读取共享策略，因为遥测 seam 只暴露采集能力，而 OTel 模式枚举位于可选的后端包中。

## 决策

遥测 seam（`@deepseek-ai/dsh-session-telemetry`）现在拥有与后端无关的共享词汇：`SessionTelemetrySharingStatus`（`full` | `feedback-only` | `disabled`），并在 `SessionTelemetryBackend` 服务类上增加一个必需的抽象 `sharing` 成员——每个后端都必须披露其策略，因此消费方只有在未挂载任何遥测服务时才渲染「未配置」。`@deepseek-ai/dsh-session-telemetry-otel` 在构造函数中把序列化的 `SessionTelemetryMode`（模式语义由[反馈门控投递决策](2026-08-05-feedback-gated-session-telemetry.zh.md)负责）映射到该状态并披露，包括 `DISABLED` 模式。`/feedback` 处理器通过插件上下文读取已挂载的服务（`ctx.get('telemetry')`，绝不是声明的注入，因此命令在无遥测时也能加载和运行），并在确认文本后追加一句共享披露：`Feedback recorded for session {id}. <句子>`。无服务 → `Session sharing is not configured.`；`disabled` → `Session sharing is disabled.`；`feedback-only` → `Session sharing is feedback-gated; recording feedback releases the session prefix for sharing.`；`full` → `Session sharing is enabled.`

披露只陈述当前的共享策略，绝不承诺投递或留存：交接是后端的非阻塞入队，批处理、重试与丢失策略仍归后端 SDK，且后续重新配置可能改变已共享的内容，因此句子不声称任何内容已到达采集端，也不声称未来的留存。披露不新增任何会话事件，也绝不会进入模型 surface；Web 客户端通过现有的命令行（`CommandNode` 的结果文本）原样渲染，无需客户端改动。

## 备选方案

**客户端新增状态 RPC 与徽标。** 拒绝，因为确认文本由宿主生成，Web 客户端已经在命令行中原样渲染命令结果文本；单独的 RPC 会在第二个 surface 重复该状态，并为一句文案新增线上契约。

**在 `command-feedback` 中声明 `telemetry` 注入。** 拒绝，因为遥测是可选的：服务缺失时声明注入会导致插件加载失败，而命令必须在无遥测时可用。插件改为在处理器执行时用 `ctx.get('telemetry')` 读取服务。

**由 OTel 包拥有词汇。** 拒绝，因为 `command-feedback` 不能依赖可选的 OTel 后端包。seam 拥有 `SessionTelemetrySharingStatus`，任何后端都能披露策略。

## 后果

确认文本对用户可见：它点名接收会话并报告当前的共享策略，如实说明 fire-and-forget 交接。包级测试为每种状态以及无服务场景固定句子；组装浏览器 e2e 以 FULL 模式挂载随附的遥测行（指向本地 dead 端点），并以 golden 固定随附默认句子（`Session sharing is enabled.`）。seam 成员是必需的，因此已挂载的后端总会披露策略，「未配置」句子如实地表示没有遥测服务；`/feedback` 命令在未挂载遥测时仍能正常工作。仍为空白的新 Web 会话不渲染命令行，因此首条消息之前记录的反馈没有可见确认（已在包 README 的限制中记录）。
