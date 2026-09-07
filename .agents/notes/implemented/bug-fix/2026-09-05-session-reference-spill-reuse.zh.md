# Agent Note: 为截断的会话引用复用 spill 存储

Status: implemented

[English](2026-09-05-session-reference-spill-reuse.md) | 中文

## 问题

有界的跨会话预览可能省略整条消息，也可能省略保留消息中的大部分文本。只看到预览的模型需要准确了解省略情况，并能检查已捕获的文本，同时不能把其他会话的指令视为当前授权。源会话继续推进或发生压缩后，再次读取无法恢复同一次观察。

## 决策

[会话引用准备](../../../../packages/context/session-reference/README.zh.md)保留既有预览策略和逐引用 JSON 字节预算。每个被截断的引用通过可选的 `ctx.get("spillStore")` 尝试 `saveText`；未截断的引用不写入产物。完整转录与有界预览来自同一份已捕获的 user／assistant 文本投影，包含压缩检查点，但排除工具、推理与其他注入上下文。不发生第二次源读取。

产物归接收上下文的目标会话所有。其描述性来源是 `{ kind: "session-reference", sessionId, label }`，其中 `sessionId` 标识被引用的会话。[spill 存储](../../../../packages/spill/spill/README.zh.md)在工具来源之外接受这一最小分支；不需要伪造工具名称或调用 id。存储归属不授权取回。

有界预览 JSON 之外的独立省略通知记录精确的 `omittedMessages` 与 `omittedBytes`。通知携带保存后的定位信息和后端 `retrievalHint`，或区分未配置存储与保存失败的不可用结果。该通知是同一条持久引用消息中的模型可见内容，而不是只供 UI 使用的元数据装饰。极小的预览预算无法移除它。保存的转录携带包括 `capturedFormatVersion` 在内的捕获元数据，以及与预览相同的不受信任背景警告。每条消息的 JSON 字符串片段每行至多包含 64 个 Unicode 码点；解码并拼接后可恢复精确文本，包括原始换行。这种固定产物格式让普通分页文件读取可以取回很长的单行文本中部，而不改变预览保留策略。

异步保存后的取消会阻止上下文发布，即使存储已经创建了产物。消费方不增加回滚或删除 API；该产物遵循后端既有过期策略。回放使用已记录的预览与通知，不会重复保存或源读取。

## 考虑过的替代方案

**另写一个会话引用文件存储。** 不予采纳，因为私有命名、会话级归属、定位指引与产物生命周期已经由 spill 存储负责。第二套存储会重复这些策略。

**保存或取回时重新读取源。** 不予采纳，因为源变更可能使产物与预览及其捕获序列不一致。保存原始投影可以保留该次观察。

**把省略与取回数据放入有界预览 JSON。** 不予采纳，因为这会让元数据占用对话预算，并可能在预算最小时恰好隐藏通知。独立的持久模型可见文本同时保留两项保证。

**所有 spill 都使用工具来源。** 不予采纳，因为会话引用没有模型发出的工具调用。虚构工具 id 会错误归属产物，而不是描述其生产者。

## 后果

模型可以检查预览省略的文本，而无需增加预览预算。通知在该预算之外增加请求 token，之后的取回再添加所请求的转录文本。存储采用尽力而为策略：不可用通知如实说明无法取回，而有界预览仍可使用。即使通知仍在持久历史中，保存的定位信息也可能过期；此功能不承诺永久归档，也无法恢复源压缩已经移除的内容。

## 验证

[单元测试](../../../../packages/context/session-reference/tests/session-reference.spec.ts)锁定省略计数、完整 Unicode 与控制字符恢复、整条消息丢弃、三个引用的隔离、无存储与保存失败、来源排除与变更隔离，以及发布前取消。[Loader 组合测试](../../../../packages/context/session-reference/tests/loader-composition.spec.ts)使用真实本地存储和分页 `read` 工具，读取巨型单行消息的中部，并检查存储归目标会话所有。[无密钥录制会话场景](../../../../snapshots/session/session-reference-spill/snapshot.yml)锁定持久的模型可见引用上下文。嵌套 Windows 定位信息回归覆盖序列化提取与规范化，且不改写无关反斜杠。回放会[规范化已知的带引号 spill 定位信息](../../../../packages/test-support/session-snapshot/README.zh.md)，同时保留保存字节数与省略计数。

## 相关决策

[工具输出 spill 决策](../architecture/2026-07-08-tool-output-spill-files.zh.md)保持活跃：其存储／策略分离、失败降级、提供方上限与取回替代方案仍约束工具消费方。本说明扩展其生产者词汇，而不替代这些理由。[分离上下文注入与轮次执行](../architecture/2026-07-24-separate-context-injection-from-turn-execution.zh.md)仍负责持久消息准入，[生产者声明的上下文形式](../feature/2026-08-05-context-form-vocabulary.zh.md)仍负责 recall 展示。
