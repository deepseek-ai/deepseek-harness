# Agent Note: 内嵌 Assistant 流的消费方直接读取紧凑记录

Status: implemented

[English](2026-09-06-embedded-stream-record-readers.md) | 中文

## 问题

Session 格式 v2 将每次模型尝试的紧凑流（`AssistantStreamRecord[]`：打包的 `text-chunks`、`reasoning-chunks`、`tool-call-chunks` run 加上带时间戳的原始 `chunk` 记录）嵌入 `assistant/message` 与 `assistant/attempt`。折叠这些 settlement 的消费方会先调用 `expandAssistantStream()`；它会物化完整的逐成员数组，因此只需一个事实的消费方（find 首个 token、最后一个 usage chunk、拼接文本、一个 block-end）也要付出 O(members) 的分配与时间：在紧凑形式之上每个成员约两个对象。

在 v2 内嵌流 settlement 随消息内容扩展、Chat 与 Trajectory 区块直接由内容结算之后，剩余的 expand 消费方是 Host 与客户端折叠：Session Stats 读取每个 `assistant/attempt` 与 `assistant/message` 的首 token 时间（每次打开 Session 的 projection 阶段）、token 计量重建提供商内容并扫描每个流到最后一个 usage chunk（projection 单元仍扫描到末尾）、子代理输出折叠拼接纯文本、Session Controller 镜像查找扫描 block-end chunk。

## 决策

`@deepseek-ai/dsh-llm` 直接从紧凑记录回答消费方问题；剩余消费方对记录做一次带提前退出的折叠。

`packages/llm/llm/src/assistant-stream.ts` 在累加器与 `expandAssistantStream` 之外导出记录级读取器：

- Chunk 规则：`isTokenDelta`（非空文本、reasoning 或 Tool-call 参数片段，或任何带名称的 Tool-call delta）、`isVisibleChunk`（非空白文本或 reasoning，或 text/reasoning/Tool call 之外的任意块开始或结束）、`chunkHasVisibleText`（非空白文本 delta 或完成的文本块）。
- Run 读取器：`runFirstTokenTime` 与 `runFirstVisibleTime` 从 `time0` 与 `dt` 间隔重建首个合格成员的时间并停止扫描；带名称的 Tool-call run 直接产出 `time0`，不读片段。
- 流读取器：`assistantStreamFirstTokenTime`、`assistantStreamHasVisibleContent`、`assistantStreamHasVisibleText`、`lastAssistantStreamChunk(stream, type)`（逆向扫描）、`assistantStreamChunks(stream, type)`、`joinAssistantStreamText` 与 `assembleAssistantStream`（每个 run 向 `BlockAssembler` 喂入一个拼接后的 delta；组装只做拼接，因此 blocks、usage、finish 与 replay state 与逐成员结果一致）。`RawStreamChunkType` 排除 delta 类型，因此原始 chunk 查找不可能静默跳过打包成员。

Session Stats 读取 `assistantStreamFirstTokenTime`；token 计量读取 `lastAssistantStreamChunk(stream, 'usage')` 并通过 `assembleAssistantStream` 组装提供商输出；子代理输出折叠追加 `joinAssistantStreamText`；Session Controller 用 `assistantStreamChunks(stream, 'block-end')` 扫描镜像。

`expandAssistantStream` 保留其严格校验与其余调用方（需要每个成员或在持久边界校验流）：Session 恢复校验、v1-to-v2 迁移校验器与发布 Worker 重放、重连基线、测试支撑。

### 测量

仓库的合成 first-open 基准（200 循环、127,400 个 released-v0 事件、1,600 条紧凑记录中的 500,000 个流式 delta；五次采样取中位数）：

| 阶段 | 之前 | 之后 |
|---|---|---|
| first-open projection | 28.0 ms | 5.9 ms |
| first-open 总计 | 76.9 ms | 53.8 ms |
| first-open 峰值 RSS | 137.2 MB | 94.6 MB |
| reopen projection | 17.8 ms | 6.5 ms |

Open、read、restore 阶段不变；读取器按构造保持相同的首 token 时间（首个合格成员即首条记录的首个合格片段，且 delta 保持有序）。

## 备选方案

**按输入数组记忆化 `expandAssistantStream`。** 展开全部流只需几十毫秒，但保留展开结果在事件生命周期内约花费紧凑流的十倍内存——这是本变更移除的瞬时分配的永久版本。读取器完全消除了对保留展开的需求。

**保留逐成员折叠。** 提前退出的 `.find` 仍然先物化整个数组，因此分配与 O(members) 时间仍在。

## 后果

Host 与客户端折叠一次内嵌结算的代价为 O(records) 加每个 run 一次拼接，且除非在持久边界校验或需要每个成员，消费方不再物化成员。token、可见性与可见文本规则在 `dsh-llm` 中只有一处，因此记录读取器与累加器的打包规则不可能漂移。

发布校验（`assertCurrentAssistantStreams`）仍在发布时重放每个 settlement；因为它必须按 chunk 证明内容一致，将其转为不入成员的 run 感知组装仍是未完成工作。
