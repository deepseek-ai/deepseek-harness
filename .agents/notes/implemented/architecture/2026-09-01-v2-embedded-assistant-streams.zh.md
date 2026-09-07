# Agent Note: 在 v2 attempt settlement 中嵌入 Assistant stream

Status: implemented

[English](2026-09-01-v2-embedded-assistant-streams.md) | 中文

## 问题

Token 粒度的 `assistant/chunk` 事件会保留精确的 stream 顺序、时间、usage、terminal state、replay metadata 与失败时的部分输出，但让每个 chunk 成为顶层 Session event 会在持久化、遥测、历史传输、索引和 Client 组装中重复信封。物理 packed row 可以减少 JSONL 字节，却不会减少逻辑事件数，也不会减少接收规范 stream 的消费方工作量。

只存储组装后的成功 message 可以消除这些开销，但会丢失失败与放弃的输出、token 边界、时间戳和确定性 provider replay。持久记录需要让每个模型 attempt 只占一个单位，同时不减少 replay、诊断、取消恢复、usage 记账、snapshot 与 UI 历史依赖的证据。

改变事件基数也会改变 Session 序号。已发布迁移必须保留无关事件的相对顺序、改写每个已声明的同 Session 引用、保留精确 fork 切点，并拒绝任何无法保持语义的关系。

## 决策

Session format v2 没有顶层 `assistant/chunk` 事件。每个模型 attempt 提交一个包含 `stream: AssistantStreamRecord[]` 的持久 settlement：

- `assistant/message` 是成功响应或具有可见组装内容的已取消响应所对应的 surface settlement。它在组装 message 旁嵌入精确的紧凑带时间 stream、可选 usage 与可选 `interrupted: true` marker。
- `assistant/attempt` 只进入日志。它保留已到达 settlement、但没有 surface message 的失败、重试、取消或 stream error attempt，因此诊断与记账不会虚构模型可见历史。

`AssistantStreamAccumulator` 对每个 chunk 只快照一次。同一 block 的连续 text、reasoning 或 tool argument delta 会变成一个紧凑 run，包含首个时间戳、精确时间戳间隔和每个原始 delta 对应的一个数组成员。其他 chunk 保留为带时间戳的 raw record。`expandAssistantStream()` 会严格校验并重建精确的带时间序列；压缩绝不会合并 delta 边界。

Migration publication verifier 与冻结的 v2 fixture validator 要求嵌入式 stream 能复现非空 `assistant/message` 的 content、usage 与 replay state。对于没有源 chunk 的已迁移旧 message，空 stream 仍然有效。普通 Session restore 只校验 runtime 直接依赖的 settlement 字段，不展开全部历史 stream；需要展开 compact stream 的 consumer 会在读取时校验 record。`assistant/message` 不能携带已停用的 chunk `sourceEventSeqs`；普通 user 与 tool surface provenance 保持可用。

### 实时呈现与持久回放

`agent/assistant-stream` 发布进程本地 start、瞬态 chunk 与 end frame。loop 会在 committed end frame 命名其类型和序号前追加完整的 `assistant/message` 或 `assistant/attempt`。abandoned end 没有 settlement。

Web follow adapter 显式选择接收这些进程本地 frame，并为每个 start 补充当时观察到的最后一个持久序号。它把 chunk 呈现为持久 cursor 之间的 Client-only `assistant/live-chunk` update，只暂存 start 之后匹配的 settlement，并在 revision 缺口时重新打开 follow。committed end 会发布具名 settlement delta，删除该 attempt 的 transient match、加入持久 entry，并只重放受影响的 Conversation Context；abandoned end 会发布不含 entry 的同类 delta。重连 baseline 携带活跃 attempt 的持久起始 cursor 与紧凑前缀。

Client event source 原样传递持久 settlement。Chat 与 Trajectory 的 Assistant node 在 attempt 活跃期间折叠 `assistant/live-chunk`，直接从 `assistant/message` 构建 settled output，并且不为展示重放 `assistant/attempt` stream。因此冷恢复的 settled presentation 不会重建逐 token timing；其他消费方需要精确证据时仍可展开持久 stream。

### 已发布 v1 到 v2 迁移

相邻迁移会校验完整的冻结 v1 产物，按 turn、step、terminal boundary 与精确 message provenance 对 chunk 分组，再为每个 attempt 替换一个 settlement。成功分组的 chunk 移入其 message。未被认领的分组会在最后一个被消费 chunk 的位置变成 `assistant/attempt`。无关的交错事件保持相对顺序，存活事件获得密集 v2 序号。该迁移边通过 `dsh-llm` 运行时的 `AssistantStreamAccumulator` 压缩嵌入 stream，而不持有冻结副本，因为该包拥有 v2 stream 编码。隔离的 publication verifier 通过 `expandAssistantStream()` 与 `BlockAssembler` 展开并重组写入后的 stream，并在发布前检查每个迁移后的 `assistant/message` 是否与其一致。日后若某个格式改变 stream 编码，必须把这些 helper 的冻结副本纳入本迁移边。

该迁移边会重映射有限的已声明引用清单：信封 provenance、surface replacement 端点、command source event、compaction range 与 shadowed list，以及 title message list。经过校验的 `session/title-llm-request` 模型可见文本会在源序号命名空间中保持逐字节不变，而它的 `messageSeqs` 字段会迁移到 v2 命名空间；因此目标校验不会根据重映射后的序号重建该文本。指向被消费 chunk 的引用会使迁移失败；它绝不会被重定向到含义不同的 settlement。该迁移边也会拒绝切开 attempt 的继承切点。

v2 物理 header 要求 `isSeeded`，且不存储数值切点。带 seed 的产物用 `session/end-seed { inherited: true }` 标记其精确切点；解码从最后一个 tagged marker 推导切点。v2 编解码器为每个持久事件写一条物理行，只对 `sourceEventSeqs` 做范围编码，并在不冻结普通事件词汇或 payload 新增项的前提下校验物理 envelope。v1-to-v2 target validator 会另行冻结 released-v2 清单，current restoration 则使用 installed Session 词汇。冻结的 v0 与 v1 编解码器继续为不可变历史 generation 解码 packed row。

新建 subagent 子项的 constructor seed 与继承的父项前缀完全相同。`Session` 会追加 tagged cut marker，随后 subagent setup 再追加子项持有的 descriptor 与 delegated policy。原 descriptor-seed helper 会被删除，因此 descriptor 绝不会计入继承内容，cold resume 则重放已经持久化的子项 setup。曾把 untagged marker 放在 descriptor 后面的历史 snapshot fixture 会在源处修正；当前比较仍会暴露 marker 数量与序号引用。

`dsh_session_log` request extension 的外层 schema 保持版本 1：它的 Session header 投影仍从逻辑 inherited cut 推导 `seedLength`，只有其中的 `sessionFormatVersion` 成员标识嵌入的逻辑 Session generation。projection unit 同样保持各自的 `stateVersion`；projection cache 把每个 checkpoint 绑定到 Session format generation，因此 generation 变化不需要提升 unit 版本。

Generation 选择与发布遵循[已发布 Session 迁移决策](2026-08-31-released-session-format-migrations.zh.md)：源路径、字节与 inode 保持不变，只发布最终具名版本 successor；保留 predecessor 不提供 fallback 或 downgrade 支持。

## 验证

紧凑 stream 测试固定 text、reasoning、tool argument、raw chunk、时间戳间隔、格式错误 record 与分离 snapshot 的精确累积和展开。v1 到 v2 测试覆盖成功与失败 attempt、交错、密集序号与引用重映射、源序号 title framing、seed 切点插入与切分拒绝、严格源与目标校验、每行一个事件的 v2 编码、与 backend 兼容的 provenance range、原始与 Zstandard 发布，以及无写入的当前读取。

合并前的 performance acceptance 在三轮、100 组 warmup pair 与 600 组 measured pair 下，针对同一批已经解析的物理 row，把静态 catalog routing 与直接 released-v2 restoration 比较；它不比较 v1 与 v2，也不计入 backend I/O。每个 pooled median 与 p95 regression 都保持在 5% 预算以内，最差 p95 regression 为 3.150%。

Agent-loop 测试固定先持久后 end 的顺序、中断的可见前缀、失败与重试 attempt、abandonment、usage 与 replay metadata。Session Controller 与 Conversation 测试固定实时瞬态显示、重连 baseline、committed settlement 发布与历史回放。Chat 与 Trajectory 测试固定实时 partial 展示和最终 message 的直接投影；TypeScript 与 Python SDK snapshot 固定外部事件表示。

## 备选方案

**只持久化组装后的成功 message。** 这会丢失部分失败输出、时间、token 边界、没有 message 的 attempt usage，以及精确确定性 replay。`assistant/attempt` 与嵌入式紧凑 stream 会保留这些事实，且不把它们加入模型历史。

**保留顶层 chunk，只打包物理行。** 这会保留 v1 逻辑表示，却让序号密度、遥测量、wire 信封、Client entry 与消费方 dispatch 继续与 token 数成正比。历史编解码器仍然解码该表示；它不是当前事件模型。

**通过历史 API 传递 packed chunk row。** 这会减少 v1 的 wire 与 Client 工作，却让 Client 拥有第二套事件词汇，并让传输继续与 token-row 基数耦合。当前 API 携带标量持久 settlement，并使用独立的实时瞬态 stream。

**在 Session Controller 中删除嵌入式 stream。** 这会减少 Client 保留的内存，却会引入第二种持久事件类型，并让面向传输的 owner 决定展示消费方需要哪些证据。实测瓶颈来自重复展开，因此由各 UI 消费方决定是否检查原样传递的 settlement。

**把 stream 存在 sidecar 或 replay-only fixture 中。** 这会把一个 attempt 的 message 与证据拆给不同持久性 owner，也无法让普通恢复 Session 获得相同的失败输出与时间事实。settlement 是原子 owner。

**把被消费 chunk 的引用重定向到其 settlement。** Chunk 与 attempt settlement 不是可互换事实。拒绝可以防止迁移悄然改变插件自有引用的含义。

## 后果

当前日志、遥测与历史页按模型 attempt 而非 token chunk 扩展，同时在每个 settlement 内保留精确 stream 证据。Client event window 保留这份紧凑证据，但 Chat 与 Trajectory 的 Assistant node 不会把 settled stream 展开成逐 delta 对象。实时呈现保持增量，并且有意仅存在于进程内。

v1 的顶层 chunk 可能在 attempt 结束前由带缓冲的持久化 writer 刷盘；与之不同，v2 在 settlement 之前没有持久 attempt 证据。如果进程或主机在 settlement 前硬中断，完整的 in-flight stream 都会丢失；`agent/assistant-stream` 不是 write-ahead log。这项取舍避免为实时输出增加第二个持久性 owner。

一个 settlement 可能很大，v1 到 v2 迁移会物化完整产物及其序号映射。封闭的 Alpha 清单会拒绝未知 v1 事件与未声明引用，而不会猜测。需要单独 chunk 的消费方调用 `expandAssistantStream()`，并且绝不能从 `agent/assistant-stream` 推断持久性。

迁移会改变被消费 v1 chunk 之后的序号，因此每个同 Session 引用都必须属于显式改写规则。该约束有意让未来的基数变化迁移保持昂贵，并防止格式链执行无声的语义重定向。
