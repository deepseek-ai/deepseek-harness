# Agent Note: 设有强制脱敏点和 OTel 后端的会话遥测 seam

Status: implemented

[English](2026-07-23-session-telemetry-otel-revival.md) | 中文

## 问题

每个想把 harness 会话接入可观测性体系的部署方都得手写一个会话日志消费方：订阅、生命周期交接、以及最难的脱敏——原始日志携带文件内容与命令输出，可能内嵌凭据。遥测 seam 和 OTel 后端曾在 `session-telemetry-otlp-rfc` 分支（PR #222/#231）上完成过一版，但从未进入 master：该提案将原始会话事件原样导出，法务评审未予通过。可复用的捕获侧设计包括后端约定、coordinator、handoff 游标与会话事件订阅；导出侧的立场才是阻塞点。

## 决策

`packages/session/`（原 `telemetry/`）以 SDK 立场复活这两个经过评审的包——harness 提供能力，部署方配置上报去向并对导出内容负责：

- **`@deepseek-ai/dsh-session-telemetry`** —— seam 本体。`SessionTelemetrySink`（`emit`/`flush?`/`shutdown`）、服务注册形态的 `SessionTelemetryBackend` 与 `SessionTelemetryCoordinator` 共同拥有生命周期本地捕获：每个新的 Session 对象从 `firstLiveSeq` 之前开始，随后逐 append firehose 以零 I/O 深拷贝、脱敏并交接每个事件；重新收养同一对象时从模块作用域游标之后继续。无缓冲按需捕获使用同样的一事件一记录映射，直到可选的包含式边界。Ledger 身份包含 `session.id`、`session.format_version` 与 `event.seq`；实时捕获还会转发 `agent/error`，并创建 dispose（资源释放）时的 `shutdown` 记录。
- **`session-telemetry/record` waterfall（瀑布式事件）** —— 相对分支版本的增量，也是该 seam 的脱敏扩展点。每条记录抵达任何后端前必经此处；seam 自身不带任何规则——最内层 `next()` 原样透传，部署方以监听器挂载自己的规则（通过变换 `next()` 的返回值堆叠），抛异常的规则将该记录 fail-closed 扣下。脱敏只作用于导出副本；canonical log 永不改写。
- **`@deepseek-ai/dsh-session-telemetry-otel`** —— 参考后端：OTel JS SDK 日志流水线（`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP exporter），经 `exporter`/`processor` passthrough 原样配置。`DISABLED` 是插件默认值，且不构造任何传输。`FEEDBACK_ONLY` 要求 `exporter.url`；[显式反馈策略](../architecture/2026-09-05-nonofficial-feedback-otel.zh.md)要求每次有界捕获都由新提交触发，适用于所有提供方。[无缓冲反馈回放](../../archived/simplification/2026-08-06-buffer-free-feedback-telemetry.md)避免在内存中创建会话前缀的第二份副本。

边界公理保持不变：harness 的职责止于 `emit()`。批处理、重试、排队与丢失策略属于 reporting SDK，并经 passthrough 配置。投递是尽力而为：崩溃可能丢失已排队记录。后端重试或丢失同一 live 对象的模块作用域游标可能重复生命周期本地 row，因此接收端基于 `(session.id, session.format_version, event.seq)` 去重。

## 考虑过的替代方案

**实现 runtime-telemetry RFC 的 outbox（落盘 spool、每 sink 游标、at-least-once、持久化 seam 的 `readCommitted` 方法）。** 推迟而非否决：SDK 立场使投递语义归属 reporting SDK，OTel SDK 自身的批处理流水线是诚实的默认。outbox 是纯增量层（`emit()` 约定不动）；待某个部署提出遥测必须满足的崩溃丢失要求时再复活。

**不设进程内脱敏点，交给接收端 collector processor。** 否决——接收端脱敏是先把秘密发出去再擦除。waterfall 在字节离开进程前提供一个可审计、可堆叠的擦除点；分支版本（PR #222 交付的形态）完全没有脱敏点，如今每条记录都必经该脱敏点。

**在 waterfall 最内层 `next()` 内置一套保守规则集。** 否决：作为 SDK 我们无法预知某个部署里什么模式算秘密，内置列表只覆盖已知形状却会带来「脱敏已开启」的虚假信心，且误报会破坏未提出此要求的消费方所接收的导出 body。seam 拥有机制，部署方拥有策略——最内层 `next()` 原样透传，规则以监听器挂载。

**映射到 OTel span（GenAI 语义约定）而非日志。** 本次复活否决：分支实现的日志映射已经过评审、形态可交付；span 模型对可 fork、可中断的会话有损，留给将来真正有 span 查询需求的消费方。

**自动回放每个 constructor seed。** fork 的继承事件和恢复的日志可能早于当前共享动作。协调器对新对象默认从 `firstLiveSeq` 开始；`includeHistory` 显式允许后端捕获存储的上下文。OTel 仅在新的自身反馈时选择完整历史，绝不在构造、恢复或 HMR 时捕获。同对象游标减少重复交接，但不保证历史投递，也不替代延后的持久化 outbox。

**将 seam 的轮次边界 `flush()` 提示转发到 OTel 提供方的 `forceFlush()`。** 首轮复活曾交付此转发，其后移除：三条不同的静默丢失路径共用同一份包装层状态——dispose 与进行中的 flush 之间的竞态（SDK 的并发 flush 防护会令 shutdown 的内部排空被跳过）、相互重叠的提示顶掉留存的 promise、以及提供方固定的 30 秒 flush 超时在批处理器仍在排空时便 reject。这些路径存在的唯一原因，是该转发让这个后端成为进程内第二个执行 flush 的组件，面对的还是上游实验性（experimental）源码树中未见诸文档的 SDK 内部行为；不实现 `flush()` 时，批处理器就是唯一执行 flush 的组件，其 `scheduledDelayMillis`（已可由部署方经 `processor` passthrough 调优）决定导出节奏，`shutdown()` 的排空从构造上就是完整的。仅当某个部署提出 `scheduledDelayMillis` 无法满足的轮次边界延迟要求时才恢复此转发——且届时应调用留存的 `BatchLogRecordProcessor` 自身的 `forceFlush()`，绝不调用提供方那个带超时包装的版本。

## 后果

部署方配置 OTLP endpoint 并选择 `FEEDBACK_ONLY`，即可在新的显式反馈时释放完整权威日志前缀。`DISABLED` 是插件默认值（[`dsh-session-telemetry-otel` README](../../../../packages/session/session-telemetry-otel/README.zh.md)），且不构造上报流水线；删除配置项是静默退出方式，而禁用模式保留本地反馈警告。SDK 定时刷新和关闭只排空已授权批次，不捕获后续记录。未挂载规则的部署会导出每条已捕获事件的正文，包括紧凑 assistant stream 以及文件内容或命令输出中内嵌的凭据，因此跨信任边界的部署必须挂载 `session-telemetry/record` 监听器。脱敏后的正文可能与权威日志字节不同；日志仍是真源。丢失交接游标可能使后续已授权捕获产生重复，崩溃持久性则在上述 outbox 决定重新审议前继续不在范围内。
