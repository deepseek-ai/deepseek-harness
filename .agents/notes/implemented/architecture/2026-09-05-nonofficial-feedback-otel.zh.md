# Agent Note: 仅在显式反馈后通过 OpenTelemetry 上传

Status: implemented

[English](2026-09-05-nonofficial-feedback-otel.md) | 中文

## 问题

反馈需要它所描述的会话上下文，以及不依赖模型提供方或后续模型请求的投递路径。普通活动不得授权上传。继承的反馈不得视为子 Session 的同意。

## 决策

基础配置为所有用户和提供方以 `FEEDBACK_ONLY` 挂载 OTel，包括 `deepseek-official` 和没有请求头的 Session。只有新的自身 `feedback/record`、`feedback/message-put` 和 `feedback/message-delete` 事件授权捕获，且截止该确切的权威事件。文本反馈、评分、实质备注编辑与撤回均算作反馈。冷会话 `feedback/committed` 通知提供已提交快照，不发布存活 Session 或 Agent。

授权前缀包含从 seq 0 到该反馈的所有尚未交接的权威上下文，而非只有反馈载荷。子会话需要新的自身反馈；之后其前缀包含继承历史。后续记录等待下一次显式反馈。请求活动、请求头、Session 创建或接纳、恢复、插件挂载和 HMR（热模块替换）绝不授权捕获；仅有存储的反馈不会触发任何上传。

后端使用包含完整历史的按需捕获与现有脱敏 waterfall（瀑布式事件）。`DISABLED` 不构造传输。`FULL` 被拒绝，不作为别名。直接调用 `ctx.sessionTelemetry.emit()` 是空操作，因此调用方不能绕过反馈授权。SDK 定时刷新和关闭可以完成先前已授权的批次，但绝不捕获新记录。提交后的发送无需进一步用户交互或模型调用。

[权威反馈决策](2026-09-05-canonical-feedback-log.zh.md)负责存储、版本、删除与纯命令确认。[需主动开启的 DeepSeek 贡献](../../../../packages/session/session-log-deepseek/README.zh.md)保持独立，保留现有目标与接受行为。

## 考虑过的替代方案

**按提供方或端点主机名过滤。** 反馈为每位用户授权相同的有界上下文；提供方选择、网关或缺失请求头不改变该授权。

**仅使用后续 DeepSeek 请求。** 其他提供方不携带 `dsh_session_log`，而最终反馈之后可能没有请求。现有 OTel 流水线可独立发送，无需自定义上传器或模型调用。

**保留持续捕获或在生命周期事件上回放存储的反馈。** 部署配置和旧反馈不授权新捕获。只有新的显式提交才授权。父会话反馈同样不能授权子会话上传。

## 后果

交接尽力而为，不代表采集端接受。同对象游标抑制重复捕获，但新冷快照和重启后的新反馈可能重复前缀；接收方按 `(session.id, session.format_version, event.seq)` 去重。没有持久化 OTel outbox、投递水位或 harness HTTP 重试承诺。入队后适用 SDK 批处理与丢失行为。OTel 与需主动开启的 DeepSeek 路径可能重叠。撤回导出删除事件，不是远端擦除。

[OTel 测试](../../../../packages/session/session-telemetry-otel/tests/otel.spec.ts)覆盖显式反馈捕获、提供方无关行为、生命周期静默、fork 同意、冷会话提交与直接调用拒绝。[协调器测试](../../../../packages/session/session-telemetry/tests/telemetry.spec.ts)覆盖历史捕获；[基础配置测试](../../../../packages/bundle/base/tests/base.spec.ts)固定挂载默认值。
