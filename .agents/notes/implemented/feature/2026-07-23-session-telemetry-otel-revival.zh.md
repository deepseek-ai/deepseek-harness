# Agent Note: 设有强制脱敏点和 OTel 后端的会话遥测 seam

Status: implemented

[English](2026-07-23-session-telemetry-otel-revival.md) | 中文

## 问题

每个想把 harness 会话接入可观测性体系的部署方都得手写一个会话日志消费方：订阅、生命周期交接、以及最难的脱敏——原始日志携带文件内容与命令输出，可能内嵌凭据。遥测 seam 和 OTel 后端曾在 `session-telemetry-otlp-rfc` 分支（PR #222/#231）上完成过一版，但从未进入 master：该提案将原始会话事件原样导出，法务评审未予通过。捕获侧设计（后端约定、coordinator、handoff 游标、分片投影）本身合理且经过评审；导出侧的立场才是阻塞点。

## 决策

`packages/session/`（原 `telemetry/`）以 SDK 立场复活这两个经过评审的包——harness 提供能力，部署方配置上报去向并对导出内容负责：

- **`@deepseek-ai/dsh-session-telemetry`** —— seam 本体。`SessionTelemetrySink`（`emit`/`flush?`/`shutdown`）、服务注册形态的 `SessionTelemetryBackend`、以及拥有捕获侧的 `SessionTelemetryCoordinator`：带游标回读的实时纳管与逐 append 的 firehose（投影 → `structuredClone` → 脱敏 → `emit`，零 I/O）、从权威日志进行的无缓冲按需回放、固定的每个（轮次、步骤）组合首分片投影、实时 `agent/error` 转发，以及实时 dispose（资源释放）时的 `shutdown` 记录。
- **`session-telemetry/record` waterfall（瀑布式事件）** —— 相对分支版本的增量，也是该 seam 的脱敏扩展点。每条记录抵达任何后端前必经此处；seam 自身不带任何规则——最内层 `next()` 原样透传，部署方以监听器挂载自己的规则（通过变换 `next()` 的返回值堆叠），抛异常的规则将该记录 fail-closed 扣下。脱敏只作用于导出副本；canonical log 永不改写。
- **`@deepseek-ai/dsh-session-telemetry-otel`** —— 参考后端：OTel JS SDK 日志流水线（`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP exporter），经 `exporter`/`processor` passthrough 原样配置。`DISABLED` 是默认值，且不构造任何传输；[反馈门控遥测决策](2026-08-05-feedback-gated-session-telemetry.zh.md)定义了需显式启用的 `FULL` 与 `FEEDBACK_ONLY` 投递模式，这两种模式要求 `exporter.url`，且不移动脱敏或后端边界。[无缓冲反馈回放](../simplification/2026-08-06-buffer-free-feedback-telemetry.zh.md)避免在内存中创建会话前缀的第二份副本。


边界公理保持不变：harness 的职责止于 `emit()`。批处理、重试、排队与丢失策略属于 reporting SDK，经 passthrough 配置——投递是尽力而为（崩溃时至多一次），两份 README 对此如实陈述。

## 考虑过的替代方案

**实现 runtime-telemetry RFC 的 outbox（落盘 spool、每 sink 游标、at-least-once、持久化 seam 的 `readCommitted` 方法）。** 推迟而非否决：SDK 立场使投递语义归属 reporting SDK，OTel SDK 自身的批处理流水线是诚实的默认。outbox 是纯增量层（`emit()` 约定不动）；待某个部署提出遥测必须满足的崩溃丢失要求时再复活。

**不设进程内脱敏点，交给接收端 collector processor。** 否决——接收端脱敏是先把秘密发出去再擦除。waterfall 在字节离开进程前提供一个可审计、可堆叠的擦除点；分支版本（PR #222 交付的形态）完全没有脱敏点，如今每条记录都必经该脱敏点。

**在 waterfall 最内层 `next()` 内置一套保守规则集。** 否决：作为 SDK 我们无法预知某个部署里什么模式算秘密，内置列表只覆盖已知形状却会带来「脱敏已开启」的虚假信心，且误报会破坏未提出此要求的消费方所接收的导出 body。seam 拥有机制，部署方拥有策略——最内层 `next()` 原样透传，规则以监听器挂载。

**映射到 OTel span（GenAI 语义约定）而非日志。** 本次复活否决：分支实现的日志映射已经过评审、形态可交付；span 模型对可 fork、可中断的会话有损，留给将来真正有 span 查询需求的消费方。

**handoff 游标未存活时全量回放日志（重新导出构造函数种子）。** 首轮复活曾交付此方案，其后收窄：接管操作现在从会话的构造边界起回放（`Session.firstLiveSeq`，即构造函数种子长度；`Session.inheritedEventCount` 不能胜任，因为它是持久保存的 fork 谱系 cut，而恢复会话的构造函数种子是其完整的已存储日志）。恢复会话的历史已由上一个进程以同一 id 发出，fork 继承的前缀也已在父会话的流中发出；再次导出任何一者，都会让每次恢复为其完整历史重复付费，并在没有原生摄取去重的 OTLP 后端上使查询时的计数翻倍。接收端基于 `session.parent_id` + `session.seed_length` 拼接 fork 谱系。此次收窄放弃的内容与至多一次立场一致：恢复不再回填上一个进程未能投递的记录（彼时遥测未挂载，或崩溃时仍在队列中）——这本是全量回放唯一的真实收益，代价却由常见情形承担。提出回填要求的部署需要的是上文已推迟的 outbox，而不是回放。该边界同样吞掉 `SessionPersistence.load()` 修复被崩溃打断的日志时写入的合成轮次关闭事件（它们落在 `firstLiveSeq` 之前，尽管在上一个进程中从未存在过）。这是有意为之，而非附带效果：远端轮次的真实尾部记录已随崩溃进程的队列一同消亡，导出合成关闭事件无法补全该轮次，只会让一个未完成的轮次看起来已经关闭。导出的流忠实于崩溃进程实际发出的内容；接收端会把恢复后的流中一个从未关闭的轮次读作「上一个进程死在了该轮次之内」（OTel README 陈述了这条规则），其后干净的 `shutdown` 标记也只证明恢复后进程自身的退出。若为让修复以实时事件的身份导出而将修复前边界贯穿 load/prepare 传递，将使三个包相互耦合，只为抹除这一信号。

**将 seam 的轮次边界 `flush()` 提示转发到 OTel 提供方的 `forceFlush()`。** 首轮复活曾交付此转发，其后移除：三条不同的静默丢失路径共用同一份包装层状态——dispose 与进行中的 flush 之间的竞态（SDK 的并发 flush 防护会令 shutdown 的内部排空被跳过）、相互重叠的提示顶掉留存的 promise、以及提供方固定的 30 秒 flush 超时在批处理器仍在排空时便 reject。这些路径存在的唯一原因，是该转发让这个后端成为进程内第二个执行 flush 的组件，面对的还是上游实验性（experimental）源码树中未见诸文档的 SDK 内部行为；不实现 `flush()` 时，批处理器就是唯一执行 flush 的组件，其 `scheduledDelayMillis`（已可由部署方经 `processor` passthrough 调优）决定导出节奏，`shutdown()` 的排空从构造上就是完整的。仅当某个部署提出 `scheduledDelayMillis` 无法满足的轮次边界延迟要求时才恢复此转发——且届时应调用留存的 `BatchLogRecordProcessor` 自身的 `forceFlush()`，绝不调用提供方那个带超时包装的版本。

## 后果

部署方在 `cordis.yml` 加一个带 OTLP endpoint 的 Cordis 配置项，并显式选择 `FULL`，即可把会话流接入任何 OTel 兼容体系；选择 `FEEDBACK_ONLY` 则会在记录反馈时回放权威日志前缀。`DISABLED` 是[默认值](2026-08-10-telemetry-default-off.zh.md)，且不构造上报流水线；删除该配置项仍是静默退出方式，而禁用模式会保留本地反馈警告。未挂载规则的部署导出的记录与捕获时完全一致，包括文件内容与命令输出中内嵌的任何凭据。因此，跨信任边界的部署必须挂载 `session-telemetry/record` 监听器，两个 README 对此如实陈述。挂载规则后，导出的 body 可能与 canonical log 字节不同，接收端不得把遥测当作字节精确副本；日志仍是真源。崩溃持久性在上述 outbox 决定重新审议前明确不在范围内。
