# Agent Note: 权威反馈日志与请求投递

Status: implemented

[English](2026-09-05-canonical-feedback-log.md) | 中文

## 问题

可编辑的消息评分需要一个能由 Session 导出与请求投递保留的持久权威来源。独立的反馈存储会让这些消费方拿到不完整的数据，并引入与目标消息之间的第二套提交关系。记录人类判断不能改变模型输入，也不能暗示采集端已经接受数据。

## 决策

权威 Session 日志拥有反馈。Session 级备注使用 `feedback/record`；消息的实质编辑与删除使用 `feedback/message-put` 和 `feedback/message-delete`。三者都仅写日志。服务从与请求的 `sessionId` 匹配的事件中归约当前条目，因此继承的父级事件不会成为 fork 的当前反馈。删除会移除当前条目，但不会抹除日志中早先的评分或备注。

live 消息反馈变更通过所属 Session 追加，并等待其持久化检查点；cold 变更在读取、比较、追加和 flush 期间持有持久化写句柄，不创建 Session 或 Agent。匹配版本的无变更操作不追加事件，但仍等待持久化。故障会原样传播，live flush 失败可能留下可观测的内存条目以供重试。逐条版本避免不同消息的编辑互相冲突；严格拒绝陈旧写入避免 ABA 覆盖，即使期望值已经匹配也不例外。目标校验把判断绑定到已发送的 assistant 消息，fork 保持独立判断。这些选择保留[已归档伴随记录决策](../../archived/architecture/2026-08-10-message-feedback-sidecar.md)记载的理由，但其存储与提交机制已被取代。

现有需显式启用的 [session-log-deepseek 贡献](../../../../packages/session/session-log-deepseek/README.zh.md)会在后续符合条件的请求中，把反馈纳入普通 `dsh_session_log` 后缀。它使用现有的 DeepSeek 目标选择和接受水位。没有独立的 `dsh_feedback` 上传器、反馈触发的 LLM 请求或模型输入字段。[显式反馈 OTel 决策](2026-09-05-nonofficial-feedback-otel.zh.md)负责面向所有用户和提供方的独立反馈触发上传。

命令用 Session 与匿名用户 id 确认记录，不依赖遥测，也不披露其策略。其追加仍不执行 flush。这取代[已归档共享披露记录](../../archived/feature/2026-08-07-feedback-acknowledgement-sharing-disclosure.md)中的命令文案决策。[遥测服务的策略 API](../../../../packages/session/session-telemetry/README.zh.md#the-sharing-disclosure) 仍可独立使用：后端披露策略，而不保证投递或保留，可选 OTel 包不拥有这套词汇。

## 考虑过的替代方案

**保留伴随记录。** 它支持破坏性的本地编辑，但若不增加关联读取及持久化关系，就无法让反馈参与普通权威日志导出与投递。

**对消息编辑复用 `feedback/record`。** 自由文本的 Session 备注不能标识条目变更。独立事件保留消息身份和删除语义；上传策略仍由消费方负责。

**增加专用反馈上传器或立即发起 LLM 请求。** 需显式启用的日志贡献在符合条件的请求上传送权威事件。现有 OTel 流水线独立处理所有提供方的显式反馈上传，无需自定义反馈上传器或另一个模型请求。

## 后果

反馈随普通日志导出与回放保留，不消耗模型输入 token，也不改变 KV Cache。删除当前条目不等于抹除历史。DeepSeek 请求贡献可能让最终反馈留在本地，直到下次符合条件的请求；OTel 按自身策略独立发送已授权批次。Web 控制器仍消费一元 Remote，不消费反馈日志事件来更新其他标签页。

[消息反馈测试](../../../../packages/feedback/message-feedback/tests/message-feedback.spec.ts)覆盖实质事件、无变更操作、严格版本、fork 隔离与持久化故障。[请求贡献测试](../../../../packages/session/session-log-deepseek/tests)负责后缀接受与重试；[命令测试](../../../../packages/feedback/command-feedback/tests/command-feedback.spec.ts)固定纯确认文本。
