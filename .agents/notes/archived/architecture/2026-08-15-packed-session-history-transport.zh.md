# Agent Note: 在会话历史中传输打包分片行

Status: implemented
Archived: 2026-09-01

[English](2026-08-15-packed-session-history-transport.md) | 中文

## 问题

`session.page` 与 `session.follow` opening snapshot 会向远程 Client 提供一段有界的逻辑 Session event 区间。提供方流可能在一个未完成尾部中产生数十万个 token 大小的 `assistant/chunk` 事件。先展开每条持久化行，再序列化每个逻辑事件，会在协议中重复相同 envelope。在 Client 边界展开 packed response 还会重新创建同样数量的 event object、journal entry、Location index、Definition match 和 State update，拖慢 conversation replay。

传输必须保持无损。Session seq 是分页与重连证据；精确 fragment 边界和时间戳对诊断与非 UI API 消费方仍然有用；实时流式传输、持久导出、回放与模型历史派生仍然需要规范事件流。当 Definition 可以直接 fold 无损 run 时，浏览器表现并不需要为每个历史 fragment 分配一个 event object 并执行一次 Definition callback。

## 决策

历史页与 follow opening snapshot 携带 `records: SessionHistoryRecord[]`。普通 record 为 `{ type: 'event', event: SessionWireEvent }`；连续且属于同一 block 的 Assistant delta event 使用[打包 JSONL 决策](2026-07-26-packed-chunk-rows-by-default.zh.md)中的共享无损 codec，表示为 `{ type: 'chunks', event: ChunkRowEvent }`。Host 在打包已选页面时只构造一次 event-shaped value。其 `type` 为 `chunkrow/text-chunks`、`chunkrow/reasoning-chunks` 或 `chunkrow/tool-call-chunks`；`seq` 与 `time` 表示首成员，`data` 保留原 fragment 与 timestamp-gap 数组。显式外层 discriminator 无需解释详细 chunk kind 即可选择 record 类别。系统先从逻辑 event 中选择页面，再执行打包，因此按消息对齐的分页不依赖物理持久化布局。

生成的 Remote decoder 会校验响应字段。`SessionEventStream` 把原始 wire record 交给 `RemoteJournalStream`，并提供每条 record 的逻辑 seq 闭区间：event 覆盖 `[event.seq, event.seq]`，row 覆盖 `[event.seq, event.seq + memberCount - 1]`。Journal 在发布 record 前检查页面连续性、分页拼接、重连修复、完整重复、部分重叠和实时 event 去重。页面请求中的 durable address 既可选择普通 Session，也可选择已授权的 direct subagent child，无需第二套历史协议。

Client 不分配替换 entry，直接把已接受的 `SessionHistoryRecord[]` 收窄为 `SessionEventLikeEntry[]`。外层 `type` 会一直保留到 journal、Session 与 assembler；两个分支都携带字段对齐的内部值，其中包含 `type`、`seq`、`time` 与 `data`。`ChunkRowEvent` 是 Client 历史数据，不是持久 Session event：它不会进入 `SessionEventMap`、`Session.events` 或 `session/event`。

Conversation 接受 Session 保留的同一组 `{ type, event }` entry。Definition 接收内部 `SessionEventLike`：`match()` 与 `update()` 接受标准或 packed value，`start()` 只接受标准 `SessionEvent`；assembler 使用外层 discriminator 拒绝 packed start。Chat Assistant、Turn Tail 和 Trajectory Assistant 在既有 reducer 中处理三种 packed tag。一条 row 因此始终只对应一个 Client entry、Conversation input 与 Match，而这些 reducer 会保留 scalar replay 的最终 block、tool-call 字段、首 token 时间、首个可见边界、retry 行为和 interruption 状态。

实时 `session.follow` frame 仍是单个 event 并走 scalar 路径，因此可见 streaming cadence 不变。Session persistence、原始导出、回放、模型历史派生与规范内存日志均不改变。

## 测量结果

测量使用了一份生产规模的私有会话样本，未保留或签入其内容。其尾页包含 416,756 个逻辑事件。无损打包响应使用 696 条顶层记录，其中包含 116 条打包行。

| 表示 | 顶层记录数 | JSON 字节 | gzip 字节 | Brotli 字节 |
| --- | ---: | ---: | ---: | ---: |
| 原始逻辑事件 | 416,756 | 69,433,638 | 4,190,226 | 1,972,998 |
| 已完成步骤投影候选 | 228,129 | 38,427,209 | 2,324,688 | 957,350 |
| 无损打包历史 | 696 | 6,362,724 | 1,154,206 | 528,145 |

与原始逻辑事件相比，打包使未压缩 JSON 减少 90.8%；与有损的已完成步骤投影候选相比减少 83.4%。Brotli 输出相对原始形式减少 73.2%，相对该投影候选减少 44.8%。这些数字描述该样本，并非协议保证；收益随 delta run 的长度与规律性变化。

一对一 Client 保留使同一规模样本保持为 696 个 history entry 与 Conversation input，而不会恢复成 416,756 个 event entry。一次本地合成 benchmark 观测到：Client parse、validation、retention 与双 Definition fold 在 scalar input 下耗时 4,682.11 ms，在 packed input 下耗时 276.10 ms；采样额外 V8 heap 峰值分别为 612,523,344 与 199,436,928 字节。这些依赖机器的数值是观测结果，不是门槛。

可选运行的 `packages/client/ui-conversation/tests/history-transport.perf.client.ts` benchmark 使用合成内容构造相同的逻辑 event 数、普通 event 数与 delta run 数。`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/ui-conversation/tests/history-transport.perf.client.ts` 会在 `HISTORY_TRANSPORT_PERF_RESULT` 下报告 wire 体积、Host／Client 计时、未压缩且采用 chunked response 的 Node loopback 传输中位数、组合后的合成 API 等待／UI 就绪时间，以及采样的额外 V8 heap 峰值；第二组清单会在 `HISTORY_WHITESPACE_PREFIX_PERF_RESULT` 下报告 10,000、20,000 与 40,000 个成员 whitespace-prefix run 的 batch fold 中位数。组合计时从内存 event 数组开始，不包含冷持久化读取、生产 API bridge 与 RPC envelope，也不包含 Chromium 调度，因此它是对比清单，而非生产环境 wall-clock 延迟。Heap 测量会在三次运行前强制执行垃圾回收，并相对于相同的已初始化 benchmark 状态，报告 Host 构造／序列化或 Client 解析／校验／保留／fold 各主要阶段之后所观察峰值的中位数；该指标不测量进程 RSS、external 或 ArrayBuffer 内存，也可能遗漏单个采样阶段内部的瞬态峰值。CI 不执行这组手动性能用例，其中也没有依赖机器性能的耗时或内存断言；结构断言固定 fixture 规模、每条 wire record 对应一个 Client input，以及双消费方 Assistant fold fixture 的一致最终状态，包括 delta 数量与末个 delta seq。

## 曾考虑的替代方案

**在 Host 丢弃已完成步骤的分片。** 这会减少逻辑事件数，但会让传输语义取决于当前 transcript 策略，从所有消费方移除精确证据，同时仍把保留的未完成步骤 token 逐个装入信封。实测打包响应在保持无损的同时更小。

**在进入 Session 对象层前展开每条 packed row。** 这会保留每个历史 delta 一次 callback 的语义，但也会重新产生 packed transport 原本可以避免的浏览器分配、索引和 fold 成本。确实需要 scalar event 的消费方仍可显式调用 `decodeStorageRecord()`。

**把原始 row 放在独立的 `.chunks` payload 下。** 这会迫使下游消费方保留两种 payload 字段名，或在进入 assembly 前分配字段对齐的包装层。共享 `.event` 字段既保留快速外层分类，也保留一条内部 Definition 路径。

**只依赖 HTTP 内容编码。** gzip 与 Brotli 会减少网络字节，但不会移除重复的 JSON 解析、校验、分配、索引与 fold 工作。

**直接按物理持久化行分页。** 这还可以避免 cold Host 读取时的逻辑展开，但页面切分取决于追加来源消息与替换 provenance，而不是 provider 行边界。当前决策让 API 保持对 JSONL 与未来持久化布局的独立性。

**只返回组装后的 Assistant 快照。** [仅保留组装消息的否决记录](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.zh.md)仍然适用：final message 之外的事件族承载用户可见状态与诊断状态，未完成步骤也需要其实际累计分片。

## 后果

历史响应保留每个逻辑 event，同时减少长 delta run 的 wire 字节、Host 响应序列化与 heap、浏览器 JSON 解析与校验、Client entry 分配，以及 Conversation dispatch。Journal 在发布前校验逻辑 range，因此 packed record 既不会产生伪 gap，也不会隐藏部分重叠。直接调用 `session.page` 的消费方必须按 `SessionHistoryRecord.type` 分支；需要逐 member event 时再显式展开 `record.event.data`。

冷持久历史仍会先解码成完整的逻辑 `SessionEvent[]`，Host 再选择页面并重新打包。因此，本决策改善的是传输与浏览器工作，不是 Host 冷读取的解码内存。消除该展开需要提供方无关的消息边界索引或单独的流式页面读取器，属于另一项优化。

默认 Client 历史路径公开 `SessionEventLike`，因此只接受规范持久 event 的消费方必须继续使用 Host `Session.events`、`session/event` 或显式 decode 路径。消费 Assistant delta 的 Definition 需要维护等价的 scalar 与 packed 分支。当前窗口已经实时接收的 scalar delta 仍保持 scalar；在线替换为 packed row 属于另一项工作，reopen 与 reconnect 则安装 packed 历史。
