# Agent Note: 历史 Session 在写入发布前提供只读迁移结果

Status: implemented

[English](2026-09-05-read-only-session-migration-preparation.md) | 中文

## 问题

有状态 Stage pipeline 已经把历史 Decode 与 migration 恢复到有界、高性能的数据流，但串行 persistence open 仍会在返回任一种 handle 前执行 encode、sync、Worker verification、publication 与 committed reopen。只读 consumer 因此需要额外等待约 2.2 秒不需要的工作，而且仅为展示历史就会修改存储。

### 串行 readable 的额外代价

- 历史分页、projection preparation、export 与 `session.follow` 的 opening snapshot 只需要已经校验的 current logical artifact。
- Historical read open 仍会创建并 sync 临时 v2 generation、启动完整 verification Worker、复查 source、发布 v2 并重新打开 target。
- Migration 在 encode 前已经得到完整 current artifact，但串行 API 只返回 committed physical snapshot。Persistence 必须再次 Decode current bytes 才能重建相同逻辑事件。
- `session.follow` 必须等 publication 完成后才能发出 opening snapshot，而 Agent resume 才是第一个真正要求 append 权限的操作。
- Read-only storage 无法提供逻辑上有效的历史 Session，因为 read open 强制发布 generation。

### 直接拆分会破坏 lifecycle 保证

- Verify 前返回 write handle 会让 append 写入 unpublished temporary file，并为已接纳事件引入第二种 durability state。
- 每次 read 后自动启动 publication，需要 backend 负责 task failure、shutdown、cleanup，以及后续 writer 加入一个自己没有请求的任务。
- Shared preparation 不能继承第一个 caller 的 AbortSignal；一个 reader 取消不能终止其他 waiter 仍依赖的工作。
- Read handle 必须先提供 prepared memory，并在其他 caller 发布后切换到 current file 与其 append tail。
- Reader 已经观察一个 prepared artifact 后，source drift 不能悄悄重跑 migration 并替换成另一份逻辑历史。

## 决策

JSONL backend 将 logical preparation 与 durable publication 分开。Read open 只等待 preparation；write open 复用 matching preparation，并在返回 writable handle 前等待 publication。

### Prepared generation API

```text
interface PreparedJsonlMigration {
  readonly sourceIdentity: JsonlPhysicalIdentity
  readonly artifact: SessionFormatArtifact
  publish(): Promise<JsonlPhysicalIdentity>
}
```

`prepareJsonlMigration()` 读取一个稳定 historical revision，只执行一次完整 Stage chain，并在不 encode、不写文件的情况下返回 current artifact。`publish()` 是幂等操作：并发与后续调用共享同一个终态 Promise（包括拒绝结果），不会对同一 prepared artifact 重复 encode。

`publish()` 把 current records 流式写入同目录排他创建的 temporary file，执行 sync，等待 bounded Worker verifier，比较 preparation 捕获的 source identity，再通过 no-overwrite 操作发布 canonical path。成功 publisher 复用 prepared logical artifact，不重新 Decode 自己的 target。竞争失败者只验证 winner 以精确 staged migration prefix 开头；append tail validation 仍属于 current reader。

Publication 调用后会运行到 settlement，不会被 write caller 中途取消。Write open 会在 publication 前后检查 caller signal，因此取消可能在后继已经提交后拒绝 open，但不会泄漏 write lease。Source identity 变化会抛出 `JsonlGenerationSourceChangedError`、删除临时文件，并且不会重复 Decode 或 migration。

### Preparation ownership 与取消

Persistence backend 按 Session id、selected source path 与 stat-derived revision 保存一个 in-flight entry：

```text
interface MigrationPreparation {
  sourcePath: string
  sourceRevision: SessionPersistenceRevision
  controller: AbortController
  promise: Promise<PreparedStoredLog>
  settled: boolean
  waiters: number
}
```

新的 read/write open 只有在 source path 与 revision 仍匹配时才加入已有 entry。`waitWithAbort()` 让每个 caller 的 AbortSignal 与 shared Promise 竞争，但不会把 caller signal 传给共享工作。只有最后一个 waiter 在 preparation 仍运行时离开，backend-owned controller 才会 abort。取消测试暂停物理读取，并在取消一个 caller 前观察到两个已注册的 waiter；仅让出一次事件循环不能证明异步路径与 revision 查找后的加入已经完成。

完成结果进入既有 bounded `coldLogMemo`。`StoredLog` 判别字段把已发布 current state 与 `PreparedStoredLog` 分开，后者的 `publication` 字段把 current logical events 与匹配的 publication operation 绑定，使 query 后紧接的 Agent resume 复用同一次 Decode 与 migration。In-flight map 只拥有运行中的工作，不是第二个 completed-result cache。

`SessionHandle.read()` 会报告 event value 是 detached 还是 shared-frozen。JSONL backend 在 memo 化前只对每个已解码 event graph 深度冻结一次，并在该处构造 `shared-frozen` 结果；后续读取和 slice 即使为空也会保留生产者建立的状态。`readColdSessionLog()` 将这些 event 与本地独占的 interrupted-turn closer 组合，并通过 `SessionObservationReader` 继续传递 `eventState`；`Session.fromRestore()` 只校验和接管 seed，不再复制或冻结。普通 create 与 fork seed 继续使用 defensive snapshot 路径。

Read-only restoration 会校验 Session runtime 直接依赖的 event 与 settlement 字段，但不会展开每一段嵌入式 Assistant stream。Publication Worker 继续执行完整 stream replay，并在提交 migrated successor 前校验 content、usage 与 replay state 一致性。已有 current-v2 文件信任其 writer；需要展开 compact stream 的 consumer 会在读取时校验 record。

### Read handle 切换

Current generation 不存在时，read open 会采用在 `state.primed` 中保存 prepared events 的 handle。后续每次 `read()` 都重新解析 current path：

```text
if current generation is absent:
  return slice of primed events
else:
  clear primed events
  read current generation and enforce non-shrinking history
```

因此，一个已有 historical Session 也可能让 `resolveCurrentLog()` 返回 `undefined`：它回答的是 current canonical file 是否存在，而不是 Session 是否可读。公开 `stat` 与 `list` 继续发现 historical header。

### Write-open publication

Write open 先取得进程内 claim 与内核支持的跨进程 lease，再重新解析 selected generation。如果它仍是 historical，就取得或复用 prepared `StoredLog` 并等待 `publish()`。之后才返回以 prepared events 为 primed state 的 write handle。

```text
write open
  → claim process-local ownership
  → acquire SessionWriteLease
  → re-resolve generation
  → join or create preparation
  → encode + sync temp
  → Worker verify
  → source identity check
  → no-overwrite publish
  → return writable handle
```

Handle 返回前，外部 caller 无法 append。因此 `append`、`flush` 与 `close` 保持普通 current-generation 行为，不需要“publishing”分支。Service `flush()` 继续只 flush 已经 adopt 的 writer；它不会把 read-only preparation 转成 write。

### Follow 与 Agent promotion

`session.follow` 通过 read path 打开历史、恢复 Session 与 projections、发出 opening snapshot，然后启动 Agent promotion。Agent resume 使用 write open，因此会在 Agent 接收新一轮对话前等待 publication。历史可见与写入就绪成为两个明确时间点，同时不引入 unpublished append state。

## 问题与方案对照

| 串行流程问题 | 实现机制 | 保证 |
|---|---|---|
| Read-only caller 等待 encode 与 verify | Read open 返回 prepared events | 首屏只等待 Decode + migration |
| 并发 historical open 重复工作 | Session/source-revision keyed single-flight | 每个 selected revision 只迁移一次 |
| 第一个 caller 拥有共享取消 | Caller-local `waitWithAbort()` + backend controller | 单个取消不终止其他 waiter |
| Query 与 resume 之间丢失 preparation | Bounded memo 中的 `PreparedStoredLog.publication` | Write open 复用相同 artifact |
| Read handle 没有 current path | Primed in-memory read | Publication 前 historical data 可读 |
| Read handle 需要观察后续 append | 重新 resolve，并从 primed data 切到 current file | Publication 后已有 handle 收敛 |
| Verify 前 append 不安全 | Write open 返回前完成 publication | 返回 writer 立即具备普通 durability |
| 自动后台 publication 无 owner | 只有 write open 调用 `publish()` | Read-only access 不产生 orphan write task |
| Reader 已看到 artifact 后 source 改变 | Publication 失败且不重跑 migration | 已暴露逻辑历史不被静默替换 |

## 验证

Benchmark 使用 Stage 决策中的同一份 116,228,655-byte v0 Zstandard Session。第一张表比较 migration 工作涉及的全部实现；后续调度明细则保持 #3585 与 preparation-first 使用同一条 Codec/Stage chain，仅改变 persistence 调度。

### 用户首次打开历史数据

| 实现 | Session restore | CPU | Peak RSS | Retained heap | 结果 |
|---|---:|---:|---:|---:|---|
| 原高性能 v0 reader | 4.594s | 6.048s | 2.720GB | 2.016GB | 不迁移，读取约 914 万个 v0 event |
| Master whole-artifact v0-to-v2 migration | >72.8s | — | Decode 阶段达到至少 7.219GB | — | 返回 handle 前 OOM |
| #3585 streaming migration + 串行 publication | 6.241s | 8.493s | 2.107GB | 477MB | 生成并发布包含 72,784 个 event 的 v2 Session |
| #3586 preparation-first 调度 | 2.954s | — | 1.026GB | 463MB | 生成相同 v2 Session，并把 publication 延迟到 write open |

Preparation-first restore 比 #3585 快 53%，也比原高性能 reader 快 36%，同时仍然完成 artifact 到 v2 的 migration。

### 调度观测点

| 用户观测点 | 串行 publication | Preparation-first | 变化 |
|---|---:|---:|---:|
| Read open + Session restore | 6.241s | 2.954s | -53% |
| `session.follow` opening snapshot | 7.587s | 2.912s | -62% |
| Agent 得到 writable Session | 6.246s | 5.161s | -17% |
| 已是 current v2 的再次打开 | 1.284s | 0.964s | -25% |
| Follow opening-snapshot peak RSS | 2.353GB | 1.059GB | -55% |

Preparation 中约 2.61 秒用于 Decode 与 migration。延后的 publication 约为 2.56 秒：encode/write/sync 0.83 秒、严格 Worker verification 1.72 秒、source check 与 atomic publication 约 0.005 秒。Read-only 请求完全不执行这段 publication。

Prepared artifact 与 Session restore 的 peak RSS 约为 1.03 GB。Preparation 与 Worker verification 同时存在时峰值约 2.19 GB，因为 parent 保留 logical artifact，而 Worker 独立校验 physical generation。

测试覆盖 shared-waiter cancellation、all-waiter cancellation、memo handoff、read-handle switching、source drift、winner collision、publication idempotence、write-open ordering、Worker failure 与 plain-Node bundled Worker entry。

## 后果

Read-only body access 不发布 generation。第一个 writer 会在 append 前支付一次 publication。已配置的 JSONL root 仍必须可读且结构有效，但 historical body migration 本身不要求写 successor。

Bounded memo 会保留一份 migrated event array，用于连接 read 与 write open。这是有意的取舍：不保留该 artifact 就必须重复 Decode 与 migration，或者无法提前提供 read。

Publication failure 会拒绝 Agent resume 和其他 write open，但不会使已经从 unchanged historical source 交付的 read result 失效。Source drift 对该 write attempt 是 terminal failure，不会触发 hidden state 重算。

Backend 仍存在一个更广泛的既有 lifecycle 缺口：dispose 不拥有每个尚未返回 handle 的 `create()` 或 `open()` operation。本决策不会向 `flush()` 增加 migration-specific tracking，也不解决通用 pending-operation 问题。

## 考虑过的替代方案

- **每个 open 都保持串行 publication**——physical state 最简单，但让 read-only 首屏多等待约 2.2 秒并要求存储可写。
- **Read 后自动后台 publish**——需要 backend task ownership、shutdown quiescence、error reporting，以及 writer 加入一个没有 caller 请求的任务。
- **Verify 前返回 writer**——要求 append 写入 unpublished stage，并为已接纳事件增加一种 durability 与 failure state。
- **每个 caller 独立 preparation**——重复最重的 Decode 与 migration，并在 list/follow/resume 并发时放大峰值内存。
- **让第一个 caller signal 取消共享工作**——使后续 caller 依赖无关的 cancellation timing。
- **Source drift 后重跑 migration**——可能替换已经展示给 reader 的历史，也会让一次逻辑 operation 重复处理同一大文件。
- **Read handle 永远停留在 primed memory**——无法观察后续 append，并偏离普通 persistence refresh 行为。
