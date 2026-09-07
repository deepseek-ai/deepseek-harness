# Agent Note: 已发布 Session 格式通过有状态流式 Stage 迁移

Status: implemented

[English](2026-08-31-released-session-format-migrations.md) | 中文

## 问题

Session 格式 v0 已随 alpha 版本发布，因此结构化 writer 变更不能再把已有 JSONL 当作可丢弃的预发布状态。第一版 whole-artifact migration 让这些日志在语义上可迁移，但它的数据模型会让一份 116 MB 真实 Session 在返回 handle 前耗尽 16 GB Node 进程。

### Whole-artifact 性能问题

- Zstandard 输入包含 317,540 个 frame，每个 frame 都单独执行一次异步解压。实现先保留全部 plaintext frame，再在 JSON 解析前统一拼接，因此创建了同等数量的 Promise、线程池与 native Decode 调度。
- Physical Decode 会在同一请求的重叠阶段物化完整 plaintext Buffer、完整字符串、全部 JSONL row、展开后的 source events、迁移后的 target events、编码后的 target rows、拼接后的目标字符串与目标 physical Buffer。
- 每个 codec 与 migration edge 都会调用 `snapshotSessionFormatJson()` 或 `snapshotSessionFormatArtifact()`，在相邻迁移前后递归复制并 deep freeze 完整 header、row、payload 与 event array。
- 已发布的 packed Assistant chunk 会先展开成约 914 万个 v0/v1 逻辑事件，再由 v1-to-v2 折叠成 72,784 个 current events。Whole-artifact API 要求两种表示和 old-to-new seq map 同时存活。
- Encode 会在内存中构造完整 JSONL 与压缩输出。成功路径随后 Decode staged target、Decode committed target，并由 persistence 再 Decode 一次以创建业务对象；它还会完整重读 source 以比较 fingerprint。
- 逐 frame `await` 没有形成有意义的有界调度。迁移前的高性能 reader 会复用一个同步 decoder，只由外层循环约每 500 ms yield 一次，从而避免数十万次异步切换。

### 既有接口使单点优化无法组合

`SessionFormatCodec` 以完整数组 Decode 与 Encode；每条相邻 `SessionFormatMigration` 接收并返回完整 `SessionFormatArtifact`；compiled chain 只能把已经物化的 artifact 交给下一条 edge。因此即使 physical decoder 单点变快，下游仍会重新创建 source-row array、expanded-event array、逐 edge snapshot 与 target-row array。

Migration 实际有状态，但 API 把它们表现为一次性函数。v0-to-v1 需要跟踪 message 与 retry identity；v1-to-v2 需要暂存一个尚未结算的 Assistant attempt、被它阻塞的后续事件，并维护 old-to-new seq 引用。把这些状态隐藏在 closure 或 push/finish helper object 中，会让运行结构与静态声明分离，也让 production、Worker verify、fixture 与 replay 使用不同入口。

## 决策

Session format 包采用有状态同步 Stage API。静态 migration declaration 描述一条相邻版本边，并为每次 artifact restore 创建新的 stage。Stage 拥有该 artifact 的可变状态；不同 Session 之间绝不共享 stage instance。

### Stage 与 Context 协议

```text
interface SessionFormatMigrationContext {
  emitEvent(event: SessionFormatEvent): void
  emitRun(run: SessionFormatEventRun): void
}

interface SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  transformEvent(
    event: SessionFormatEvent,
    context: SessionFormatMigrationContext,
  ): void
  transformRun(
    run: SessionFormatEventRun,
    context: SessionFormatMigrationContext,
  ): void
  finish(context: SessionFormatMigrationContext): number
}
```

`SessionFormatMigrationContext.emitEvent()` 与 `emitRun()` 都是同步操作。Producer 会声明其发出单个事件还是紧凑 run，因此热路径不会根据已解析文件对象的属性推断类别。调度归 caller 所有，context 在每次调用时传入，而不是把 callback 注入 stage constructor。一个输入可以输出零个、一个或多个值，不需要分配临时返回数组，也不需要 stage 内部保留输出队列。

`SessionFormatMigration` 继续作为 immutable declaration，声明版本号、header migration、target-header validation 与 `createStage()`。`CompiledSessionFormatChain` 只校验一次唯一、无缺口的 edge 序列，按 source-to-target 顺序创建每次 artifact 独占的 stage，再按反方向用 context 连接它们。`finish()` 按 source-to-target 顺序关闭 stage，使每一级都能在下游关闭前发出尾部数据。

```text
JSONL record
  → released physical row decoder
  → v0-to-v1 stage
  → v1-to-v2 stage
  → current event collector
```

Chain 中不存在 `flatMap`、spread expansion、中间 event array 或 scheduler。只有在每个 migration stage 都已获得直接消费 compact run 的机会后，最终 event collector 才会展开它。

### Physical codec 与 packed run

每个 released codec 会用显式 `strict` 或 `recoverable` 策略创建 row decoder。Decoder 每次通过不同的 context 方法校验并 emit 一个 event 或 codec-owned `SessionFormatEventRun`。v0-to-v1 与 v1-to-v2 都实现 `transformEvent()` 和 `transformRun()`，因此 packed Assistant chunk 可以直接到达 folding edge，无需先变成数百万个普通事件。

v0-to-v1 除了有限的 released-v0 归一化外，会保留逻辑 header、seq、引用、时间戳与 payload。它转换已移除的 `steering/message` 与 `compact/*` 事件名称，接受出现在对应 `step/end` 之后的已发布 `llm/retry`，按 turn／step／provider／policy chain 为缺失的 `llm/retry.retryId` 确定性补值，并为省略 id 的旧 compaction group 确定性补充同一个 `compactionId`。v1-to-v2 负责 attempt folding 与引用重写，并且只 emit 已结算的 current event。它会把旧的 goal 来源 user message 拆成 `goal/change` 与原本的模型可见 message。它还会为一种有限的已发布 restart 插入 interrupted `turn/end`：一个没有 open step 的 open turn 后出现非空 `next-turn` inbox splice，随后直接开始编号连续的下一轮。

Catalog 为 production、Worker、fixture 与 replay 暴露同一个 `createRestore()`。Recovery policy 与最终 validation policy 在 restore 创建时一次确定。Historical production 使用 recoverable source parsing 与 transformed-current validation；这种策略会在迁移后校验已发布 current 结果，而已经是 current 的输入只接受 codec 校验。Worker 与 fixture verification 使用 strict parsing 与已安装 current 格式的完整 restoration。Migration stage 或 transformed-current validation 的拒绝会保持为 `SessionFormatUnsupportedMigrationError`；物理解码失败仍是 corruption。Test support 只保留 fixture 自身需要的 token 和 envelope materialization。

### JSONL 串联

JSONL provider 只扫描一次 frame boundary，复用一个 Zstandard decoder，增量解析完整 JSONL record，并把 row 直接送入 catalog restore。外层循环按有界 cadence yield；不存在逐 frame `await`、完整 plaintext 或 source-row array。

Current encode 以单条 record 为单位。Provider 在主线程每个 slice 序列化约 1 MiB plaintext，通过一个会传播 source error 的 Zstandard context 流式压缩，以 4 MiB batch 写入同目录排他创建的临时文件，并在 publication 前 sync。进程级 scheduler 最多允许两个完整 verification Worker 并行，并把释放的 permit 直接交给最早的 waiter。

Preparation 会把 cancellation 传给 source read，并在现有的约 500 ms Decode yield 边界观察它。`publish()` 一旦开始，encode、Worker verification 与 publication 不接收 caller cancellation，并运行到终态；write open 会在之后再次检查 caller signal。已经发布的 generation 绝不会回滚。

Stage pipeline 终止于一份 prepared current artifact。[历史 Session 只读迁移准备](2026-09-05-read-only-session-migration-preparation.zh.md)定义 read open 如何立即消费该 artifact，以及 write open 如何在返回 append 权限前完成 encode、verification 与 publication。

### Durable format 与 publication 规则

规范文件名编码 physical format generation：v0 使用 `session.jsonl[.zstd]`，正 generation 使用 `session.vN.jsonl[.zstd]`。Migration 不会移动、覆盖或删除任何 committed generation，并且只写最终 current target；中间版本只存在于 stage state。

POSIX publication 使用 hard-link creation 加目录 sync；Windows 使用 no-overwrite、write-through 的 `MoveFileExW`。已有 target 只有在其已校验 migration prefix 等于 staged bytes 时才会被接受；任何 append tail 都属于 current-generation reader，而不是 migration winner verification。

既有 write handle 继续使用进程内 claim 与内核支持的跨进程 `SessionWriteLease`。仅 header 的 `stat` 与 `list` 可以转换受支持的历史 header，但不打开 body，也不发布 generation。Projection-cache record 会把 fold 绑定到 Session header 的 format version，使 cache row 不能绕过改变 event 基数的 migration。

## 问题与方案对照

| Whole-artifact 问题 | 实现机制 | 结果 |
|---|---|---|
| 每个 Zstandard frame 单独异步 Decode | 一个可复用 decoder；外层 500 ms 调度 cadence | 删除 317,540 次异步切换 |
| 完整 plaintext、string 与 row array | 增量 JSONL parser 与 row decoder | 只保留一条跨 chunk 残行 |
| 每条 edge 之间都形成完整 event array | Context 直连的有状态 stage | 不保留中间版本 event array |
| Packed chunk 在 folding 前完整展开 | `SessionFormatEventRun` 与 `transformRun()` | 无需物化 914 万 source events |
| 每条 edge 都 whole-artifact snapshot/deep freeze | Stage-owned 独占值与最终 validation | 删除重复递归复制与冻结 |
| One-shot migration function 隐藏状态 | Immutable declaration 创建每次 artifact 独占的 stage class | 状态 ownership 与并发关系显式化 |
| Bulk current encode 构造完整 string/Buffer | 单条 record encoder、1 MiB input slice、4 MiB write batch | 限制分配与主线程 slice |
| 主线程重复执行完整 verification | 最多两个 complete-generation Worker | Verification CPU 不占用主线程 |
| Production 与 fixture 使用不同 migration API | Catalog `createRestore()` 加显式 policy | 只保留一套 decoder/chain 实现 |

## 验证

### Benchmark 输入与口径

Benchmark 使用 Node v24.18.0 和一份 116,228,655-byte 的 v0 Zstandard 日志，其中包含 317,540 个 frame 与 454,151 个 physical row。老 reader 会恢复 9,143,111 个展开后的 v0 event；migration 会生成 72,784 个 current v2 event，artifact SHA-256 为 `fa16ff9472ca350595a3112c20a3db79655bc2673973469987ecaf2a57ebd17c`。

所有样本均通过 plain Node 运行 build artifact，每个样本使用独立进程，V8 heap limit 为 16 GB。“Retained heap”表示 restored Session 仍存活时强制 GC 后的 heap。除无法得到 handle 的 whole-artifact 失败外，下表使用三次运行中位数。

### Physical Decode

| 数据路径 | Decode 耗时 | 峰值 RSS | 调度 |
|---|---:|---:|---|
| Migration 前的高性能 reader | 1.553s | 916MB | 一个 decoder；外层 yield 2–3 次 |
| Whole-artifact migration | 7.527s | 7,219MB | 317,540 次 async decoder 调用 |
| Streaming Stage 路径 | 1.467s | 908MB | 一个 decoder；外层 yield 2 次 |

### 历史文件首次冷打开

| 版本 | Session restore 完成 | CPU 时间 | 峰值 RSS | Retained heap | Restore event 数 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| Migration 前的高性能 v0 reader | 4.594s | 6.048s | 2.720GB | 2.016GB | 9,143,111 | 读取 v0，不迁移 |
| Whole-artifact migration | >72.8s | — | Decode 阶段已 ≥7.219GB | — | — | 返回 handle 前 OOM |
| Streaming Stage migration + 串行 publication | 6.241s | 8.493s | 2.107GB | 477MB | 72,784 | 发布并打开 v2 |

老 reader 的一次性 wall time 更低，因为它不做格式转换和 durable publication；同时它会常驻 914 万 event 的表示。Stage 路径只多支付一次 encode 与 verification，随后保留折叠后的 v2 state。

### Current-format 冷打开

| 版本读取自己的 current format | Session restore 完成 | 峰值 RSS | Retained heap |
|---|---:|---:|---:|
| 老 reader 读取 v0 | 4.594s | 2.720GB | 2.016GB |
| Whole-artifact 时代 reader 读取 v2 | 1.273s | 1.107GB | 476MB |
| Streaming Stage reader 读取 v2 | 1.284s | 1.109GB | 476MB |

Current-v2 快路径保持性能等价。架构改造不会让 current data 进入 historical stage。

### Streaming 串行 migration 分段

下表记录该 Stage 决策测量的串行 open 流程。当前 preparation-first 调度及其测量由[历史 Session 只读迁移准备](2026-09-05-read-only-session-migration-preparation.zh.md)记录。

| 阶段 | 中位耗时 |
|---|---:|
| Source Decode + migration | 2.784s |
| Encode + write + sync | 0.956s |
| staged 文件完整 Worker verify | 1.415s |
| Source recheck + no-overwrite publication | 0.106s |
| committed-prefix verify + header reopen | 0.046s |
| Generation ensure-current 总计 | 5.318s |
| Persistence 观察到的最终 current Decode | 0.620s |
| Session restore | 0.594s |
| 端到端 Session restore 完成 | 6.241s |

Generation 分段与端到端数据来自不同 instrumented run，因此四舍五入后的各行不要求精确相加。

Format、catalog、edge、JSONL、fixture、replay 与 built-Worker 测试覆盖两种编码、packed run、仅 header 分类、torn tail、migration refusal、确定性 legacy normalization、source change、target collision、write lease 与 Worker failure。

## 后果

最终 current-event array 仍然不可消除，因为 Session restore 与 Agent 执行需要完整历史。Stage 架构删除完整 source 与中间 target array，但不承诺内存与分页窗口大小成正比。

解码后的单条 `assistant/chunk` 会接受 envelope 校验与最终 target 校验，但其完整冻结 v1 source payload 成员校验仍处于延期状态，因为这项逐事件检查会显著影响已发布日志的 Decode 与 migration 耗时。Packed Assistant run 仍接受严格解码。只有性能证据表明不会破坏该迁移路径的已测表现时，才能恢复单条 chunk 校验。

Read-only access 会在 durable publication 前消费 Stage 结果；write open 则复用同一结果，并在 append 前等待 publication。Persistence 调度仍与 format pipeline 相互独立。

低 generation 为 operator 检查而保留。Retention 不承诺 downgrade compatibility、automatic fallback，也不保证旧 runtime 能安全理解新 generation。

## 考虑过的替代方案

- **只优化 Zstandard Decode**——可以恢复 physical Decode 速度，但 source rows、expanded events、snapshot、intermediate artifact 与 bulk encode 仍会留在内存中。
- **同步 Generator stage**——每个 yield 都会保留执行帧与 batch。真实日志测量使 migration 更慢，并让 migrate-complete RSS 从约 1.0 GB 增长到约 1.2 GB。
- **每个 stage 返回数组**——只是给旧的 allocation、遍历与 flattening cost 换了名字。
- **Stage 内部输出队列**——增加 drain、EOF 与 error ownership，同时仍会保留中间值。
- **通过 constructor 注入 emit callback**——迫使 chain 反向构建或引入 partially connected lifecycle。操作时传 context 可以让 stage construction 不依赖下游 wiring。
- **全局复用有状态 codec instance**——会让不同 Session 的 pending attempt、mapping 与 counter 相互污染。
- **持久化每个中间格式版本**——产生没有 runtime consumer 的 durable state；只需要精确 source 与最终 current generation。
- **让 mounted plugin 注册 migration**——使历史可读性依赖部署。Static catalog 必须在 feature plugin 挂载前恢复已发布格式。
