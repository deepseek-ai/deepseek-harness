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
  → v2-to-v3 stage
  → v3-to-v4 stage
  → current event collector
```

Chain 中不存在 `flatMap`、spread expansion、中间 event array 或 scheduler。只有在每个 migration stage 都已获得直接消费 compact run 的机会后，最终 event collector 才会展开它。

### 相邻版本所有权

[V3 到 V4 规范](../../../../packages/session/session-format-v3-to-v4/README.zh.md#v3-to-v4-specification)规定父目录补全：它推进 header 版本，保留已接纳的事件与继承切点，并根据子 Session 证据追加缺失的自身目录记录。它复用 V2→V3 中冻结的 V3 codec。按 generation 校验 delivery 可防止历史确认仅因 header 变化而获得当前水位含义；更早的 migration edge 保留各自的来源准入策略。

[V2 到 V3 投递保护](../../../../packages/session/session-format-v2-to-v3/README.zh.md#delivery-guards)防止源代中被忽略的标记仅因头部变化就成为有效上传水位。Python 发布冒烟测试独立于跨代 golden 比较，按源代码中的 `SESSION_FORMAT_VERSION` 检查生成日志，因此文件名与 header 自洽不能掩盖过期 writer。

[V2 到 V3 README](../../../../packages/session/session-format-v2-to-v3/README.zh.md#v2-to-v3-specification)是该迁移边转换、保留与拒绝规则的单一规范真源；单列的[原生准入章节](../../../../packages/session/session-format-v2-to-v3/README.zh.md#native-v3-admission)避免将仅当前版本支持的能力误认为历史转换。已发布 V2 codec 仍归 V1→V2 所有，并被复用而非复制。[系统提示词](2026-09-02-system-prompt-as-surface-node.zh.md)、[PTC](../feature/2026-06-15-ptc.zh.md)和[规范信封](2026-09-06-v3-canonical-session-envelopes.zh.md)记录保留各自独立依据，而非重复转换规范。[格式版本实操手册](../../../../docs/cookbook/adding-a-session-format-version.zh.md)负责包接线、当前消费方、快照后继代际与验证命令。

历史内容准入归入边所有，而非原生 V3 扩展校验。在不了解字段的情况下保留未知块，不能证明迁移保留了其含义。因此，[源审计](../../../../packages/session/session-format-v2-to-v3/README.zh.md#source-audit)在明确归其所有的内容位置（包括未完成的流）使用同一历史种类集合。它检查已接纳的内容而不改写，并且不解释归其他所有者所有的不透明 JSON。收紧原生准入或修改冻结的前代校验器，会改变独立承诺，而非证明转换安全。

预设更名覆盖创建头部和每条选择事件，因为最新选择决定恢复时的预设，而更早的选择决定历史 fork 的预设。只改写最后一条选择会丢失这种区别。已发布的 `code` 标识表示旧内置预设；迁移不依赖已安装的预设列表，因此相同字节在每台主机上产生相同结果。原生 V3 的自定义标识仍可使用，无需全局运行时别名。

源继承数量在 EOF 前可能未知：V2 从种子标记推导它，而 V1→V2 可以改变事件数量。迁移链将这种缺失传递给下一个 Stage，而不伪造数量。[V2 到 V3 继承规则](../../../../packages/session/session-format-v2-to-v3/README.zh.md#sequence-references)支持此情况；需要 header 提供数量的旧 Stage 仍在数量缺失时拒绝。这使有种子的多跳恢复无需保留中间产物数组。

[版本与发布状态参考](../../../../docs/session-format-status.zh.md)拥有已发布格式记录，并指明代码中的写入器真源。已发布格式保留其语义；迁移期间已提交代际的字节保持不变。对已发布目标格式的破坏性变更必须按[版本规则](2026-08-10-session-log-version-mechanism.zh.md)添加下一条相邻迁移边。传入转换器修复影响之后的历史转换，不影响已有目标格式文件；[cookbook](../../../../docs/cookbook/adding-a-session-format-version.zh.md)拥有兼容性评审和 alpha 支持政策。普通事件新增遵循该规则的必需事件拒绝机制，而非自动分配版本。集成测试使用隔离、可丢弃的 home 和未变更的历史输入。

[已提交语料清单](../../../../packages/test-support/llm-replay/tests/session-format-corpus-inventory.ts) 按源路径、代际与精确拒绝原因标识有意不支持的历史转换。保留这些产物不能迫使迁移改变时序，也不能允许统一跳过：每个清单中的产物仍必须抛出类型化迁移拒绝，未列入的产物必须还原。原生当前代际 fixture 不经过入边，因此不能被归为不支持。没有版本 header 的测试框架协议示例保持为独立的显式类别。语料测试在还原成功和拒绝后都检查源字节；它不通过改写历史证据来满足当前 reader。

### Physical codec 与 packed run

每个 released codec 会用显式 `strict` 或 `recoverable` 策略创建 row decoder。Decoder 每次通过不同的 context 方法校验并 emit 一个 event 或 codec-owned `SessionFormatEventRun`。v0-to-v1 与 v1-to-v2 都实现 `transformEvent()` 和 `transformRun()`，因此 packed Assistant chunk 可以直接到达 folding edge，无需先变成数百万个普通事件。

v0-to-v1 除了有限的 released-v0 归一化外，会保留逻辑 header、seq、引用、时间戳与 payload。它转换已移除的 `steering/message` 与 `compact/*` 事件名称，接受出现在对应 `step/end` 之后的已发布 `llm/retry`，按 turn／step／provider／policy chain 为缺失的 `llm/retry.retryId` 确定性补值，并为省略 id 的旧 compaction group 确定性补充同一个 `compactionId`。v1-to-v2 负责 attempt folding 与引用重写，并且只 emit 已结算的 v2 event。它会把旧的 goal 来源 user message 拆成 `goal/change` 与原本的模型可见 message。它还会为一种有限的已发布 restart 插入 interrupted `turn/end`：一个没有 open step 的 open turn 后出现非空 `next-turn` inbox splice，随后直接开始编号连续的下一轮。

V3-to-V4 边对直接写成 V3 的日志应用同样的有限 restart 修复。将修复保留在迁入边，可以维持[原生 V4 生命周期校验](2026-09-17-native-v4-read-validation.zh.md)；若在那里接受重复 start，新日志也会允许生产者损坏。插入事件要求重映射本地引用与继承截点，而捕获代际保留原坐标。[格式规范](../../../../packages/session/session-format-v3-to-v4/README.zh.md#sequence-references)负责定义具体证据和字段。

Catalog 为 production、Worker、fixture 与 replay 暴露同一个 `createRestore()`。Recovery policy 与最终 validation policy 在 restore 创建时一次确定。Historical production 使用 recoverable source parsing 与 transformed-current validation；这种策略会在迁移后校验已发布 current 结果，而已经是 current 的输入只接受 codec 校验。Worker 与 fixture verification 使用 strict parsing 与已安装 current 格式的完整 restoration。Migration stage 或 transformed-current validation 的拒绝会保持为 `SessionFormatUnsupportedMigrationError`；物理解码失败仍是 corruption。Test support 只保留 fixture 自身需要的 token 和 envelope materialization。

### JSONL 串联

JSONL provider 只扫描一次 frame boundary，复用一个 Zstandard decoder，增量解析完整 JSONL record，并把 row 直接送入 catalog restore。外层循环按有界 cadence yield；不存在逐 frame `await`、完整 plaintext 或 source-row array。

Current encode 以单条 record 为单位。Provider 在主线程每个 slice 序列化约 1 MiB plaintext，通过一个会传播 source error 的 Zstandard context 流式压缩，以 4 MiB batch 写入同目录排他创建的临时文件，并在 publication 前 sync。进程级 scheduler 最多允许两个完整 verification Worker 并行，并把释放的 permit 直接交给最早的 waiter。

发布的 `lib/worker.cjs` 将 JavaScript workspace 依赖一起打包，使每个新 verifier 无需解析并编译它们的运行时模块图。Worker 只通过普通 request/result 消息通信，与 host 不共享 service 或 class identity，因此可以这样处理。Host build 应用现有 TypeScript 与 Typert 转换；Client pass 跳过这个 Node-only package，不会用未经转换的源代码覆盖 worker。Native add-on 保持 external。Verification、scheduler admission、termination 与 durable publication 仍在 writable open 返回前完成。Built-worker 冒烟测试把 package manifest 与 worker 复制到隔离的临时 package，移除环境中的模块搜索路径，接受有效 generation，并拒绝错误的 event count。

[浏览器 preview 打包器](../../../../packages/experimental/webworker-packer/README.zh.md)在 Node 中为随包 Session 数据准备当前代际后继，并使用同一根目录中直属子 Session 的 descriptor 作为父目录证据。浏览器 host 未实现 `node:worker_threads`，因此打包阶段的准备同时保留不可变 fixture 代际与运行时 JSONL 的 Worker 校验要求。

Preparation 会把 cancellation 传给 source read，并在现有的约 500 ms Decode yield 边界观察它。`publish()` 一旦开始，encode、Worker verification 与 publication 不接收 caller cancellation，并运行到终态；write open 会在之后再次检查 caller signal。已经发布的 generation 绝不会回滚。

Stage pipeline 终止于一份 prepared current artifact。[历史 Session 只读迁移准备](2026-09-05-read-only-session-migration-preparation.zh.md)定义 read open 如何立即消费该 artifact，以及 write open 如何在返回 append 权限前完成 encode、verification 与 publication。

批量 V4 迁移命令在有界任务队列中共享一个 JSONL persistence Context，保留 backend 的双 Worker 校验上限，以及复用近期已解码日志的缓存。子 Session 并发发布可能改变父 Session 选中的子代际；普通修订检查会拒绝这次尝试。命令只把这种源变化错误延后到初始队列清空后串行重试一次，重新收集证据，不放宽发布检查，也不重试无关失败。

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

### 父目录前置事实

本段的运行时子会话错误处理部分由[逐会话目录准备](../bug-fix/2026-09-19-session-local-subagent-migration.zh.md)取代：打开父会话仍通过读取直属子会话补齐目录，但不可读子会话不再阻断健康父历史。V3→V4 使用保留的直属子 Session header 和自身 descriptor 补齐父 Session 的子代理发现记录。存储将紧凑的 descriptor 证据提供给 catalog 组装处，由其绑定到 V3→V4 stage 工厂；Stage 等待父 Session 的最终继承截点确定后，才校验目录 payload 并导出可获得的自身发现事实。嵌套的 seed 标记丢弃继承目录候选，不解释其 payload。已有目录记录允许 descriptor 不可用，包括在首次 step 之前失败的子 Session。Descriptor v1 表示 continuable 模式；v2/v3 显式记录模式。可获得且明确的发现字段必须与父目录一致；新增完整记录要求一个受支持的 descriptor。Descriptor 缺失、版本不受支持或存在多个时，保留日志与未知模式成员关系，不编造发现字段，理由见[不完整子目录证据](../bug-fix/2026-09-19-v3-incomplete-child-catalog-evidence.zh.md)。JSONL 在准备、复用和发布时重新检查关联成员与来源修订。不可读或不支持的 header 不参与发现；读取已识别子会话失败时，其 header 身份保留为未知模式成员关系。来源变化使准备缓存失效；只读打开自动重试一次，写打开则拒绝发布。诊断保留出错子日志的路径，并区分不支持的迁移证据与畸形子数据。收集器将子解码和 descriptor 失败报告为带子路径的警告；取消与来源一致性检查仍中止准备。仅支持 V0–V3 的目录避免递归迁移子 Session。当前 V4 读取跳过该扫描，但会执行与严格恢复相同的自身目录字段、唯一性及当前投递归属检查。见[格式规范](../../../../packages/session/session-format-v3-to-v4/README.zh.md)。

原始父子迁移测试保留 24 个历史创建时间冲突作为拒绝证据。独立的内存对照只对齐子创建时间，证明恢复保留事件，包括已发布但没有 descriptor 的子 Session。Headless/ACP 与 SDK 快照适配器在规范化之前校验实时父子时钟，并在刷新时保持两者相等；已提交的前代文件保持不变。

历史格式的公开修订号组合父日志物理修订号与每个所选规范路径及其文件系统修订号的指纹。仅父日志令牌无法标识子日志提供的目录变化；全库指纹让 `stat`/`list` 保持只读元数据，也纳入不可读或不支持的成员，无需新增持久化索引。无关变化也会使历史缓存失效，获取令牌需要扫描根目录。当前格式令牌仍只取决于自身文件。准备缓存保留父日志物理修订号，并独立校验子成员集合与修订。

通用格式接口只传递正在恢复的 artifact。每个父 Session 的 catalog 组装将 V3→V4 声明替换为捕获已收集子 Session 证据的闭包，并复用生成的 codec、迁移与校验清单。每次父 Session 准备只编译一条短迁移链，每次恢复拥有独立的 stage 状态。在组装处绑定证据，使通用恢复选项和 stage 输入不必携带子 Session 证据，同时保留存储对发现与来源重验的所有权。静态 header 和原生当前格式读取不需要子 Session 证据；未绑定的历史正文恢复会拒绝，不会假定子 Session 集合为空。

<a id="catalog-scan-measurements"></a>
### 目录扫描测量

包内[诊断脚本](../../../../packages/session/session-persistence-jsonl/tests/catalog-migration.perf.ts)测量一个原始 V3 父日志、四个各有 1,000 条事件的直属子日志，以及 0/100/1,000 个只有 header 的无关 V3 Session。每个样本在新进程中创建独立临时日志库与 Cordis 上下文，按 stat → 冷读 → 缓存读取 → 写入发布 → 当前格式热读顺序执行，最后释放上下文并删除文件。脚本在普通 Node 下使用已构建的工作区导出；创建夹具不计入测量区间。这些结果是夹具创建后的文件系统缓存热态观察，不代表磁盘冷读延迟，也不是性能门禁。

以下为 macOS arm64、Node v26.0.0 下各规模的全部三个样本，单位为毫秒。只读打开不发布后继：即使解码结果已缓存，成员扫描仍与日志库规模成正比。1,000 个无关日志时，中位数分别为 stat 84.14 ms、冷读 237.97 ms、缓存读取 110.98 ms、发布 268.46 ms，以及同进程当前格式读取 0.41 ms。这些测量记录成本，不证明性能提升，也不设跨主机阈值。

| 无关 Session | 历史 stat | 冷读 | 缓存读取 | 发布 | 当前格式热读 |
|---:|---:|---:|---:|---:|---:|
| 0 | 5.17 | 19.00 | 1.36 | 42.88 | 0.47 |
| 0 | 3.30 | 14.87 | 1.45 | 35.75 | 0.41 |
| 0 | 3.18 | 16.71 | 1.50 | 34.51 | 0.47 |
| 100 | 29.44 | 77.48 | 17.01 | 60.66 | 0.43 |
| 100 | 12.42 | 42.71 | 13.69 | 60.19 | 0.43 |
| 100 | 11.19 | 41.06 | 12.61 | 57.18 | 0.39 |
| 1000 | 84.14 | 237.97 | 109.86 | 284.96 | 0.48 |
| 1000 | 99.41 | 259.88 | 123.50 | 268.46 | 0.41 |
| 1000 | 75.40 | 236.64 | 110.98 | 247.69 | 0.39 |

在仓库根目录构建运行时后执行：

```sh
pnpm run build:lib:host
cd packages/session/session-persistence-jsonl
node --input-type=module -e 'import { build } from "tsdown"; await build({ config: false, entry: ["tests/catalog-migration.perf.ts"], outDir: ".artifacts/perf", tsconfig: false, dts: false, deps: { neverBundle: [/^@deepseek-ai\//], onlyBundle: false } })'
node .artifacts/perf/catalog-migration.perf.mjs
```

## 验证

迁移规范要求分别提供转换、保留与拒绝的证据。直接迁移边和原生 V3 测试不能证明有种子的多跳发布：前代 assistant 流折叠会在 V3 插入系统事件前改变源坐标。因此，经过真实目录与 JSONL 提供方的测试需要原始及压缩的 V0/V1 输入、映射后的引用和继承切点、发布/重新打开等价性、前代字节不变，以及不产生中间代。覆盖率百分比本身不能证明这些跨阶段关系；组合断言必须比较结果历史与拒绝效果。

内容准入证据必须覆盖规范列出的每个位置、嵌套结果、未完成的起始记录和已知种类的畸形块，并验证诊断使用源坐标。成功迁移必须保留已接纳的内容与不透明值。经真实持久化路径拒绝时，必须保持源不变且不发布后继代。原生 V3 测试必须独立证明两种目录校验策略均保留扩展准入；历史拒绝不能证明原生输入也被拒绝。

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
