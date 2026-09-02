# Agent Note: 基于句柄的会话持久化

Status: implemented

[English](2026-08-27-handle-based-session-persistence.md) | 中文

## 问题

先前的持久化 seam 承担的远不止存储。一个共享协调器订阅 `session/created`/`session/event`/`session/flush`/`session/disposed`，并接管任何已发布的会话（无主认领、HMR 重新播种、已存储前缀接管）；一个带独占预留的有界已准备 Session LRU 用同一个缓存服务恢复与只读观察；提交式崩溃修复内嵌在 `load`/`prepare` 中；乐观的 revision 读取/复核/再读取循环充当所有权的替身，因此持续的外部写入方可能使读取活锁，而且没有任何机制排除第二个写入方。服务表面（十二个方法）把存储与 Session 构造和生命周期混在一起。跨进程写所有权——下一步——在那种形态里没有诚实的归宿：所有权属于一条有明确持有者的逐会话通道，而不属于一个全局监听器。

## 决策

**该 seam 是五个返回或供给逐会话句柄的服务方法。**`create(header)` 存储一个新会话并返回其持有的写句柄；`open(id, 'read' | 'write')` 打开一个已有会话；`stat(id)`/`list()` 观察快照（`header`、不透明 `revision`、可选的 `eventCount`/`sizeBytes` 提示——JSONL 后端提供 `sizeBytes`），而不读取日志；服务级 `flush()` 是一道后端范围的持久性屏障，排空并 flush 每一个活跃写句柄，逐会话聚合失败而不中途放弃清扫。该 seam 不承载原始工件导出：WebUI 的 ZIP 下载在 dsh-session-log-export 中从读句柄序列化逻辑日志（header 行 + 事件），因此每个后端的导出完全一致，仅 JSONL 可用的 501 路径也随之消失。`SessionHandle` 承载 `read(offset?, length?)`（经过验证的连续前缀切片，绝不返回撕裂尾部，逐句柄单调）、`append`（连续；完成时的持久化是尽力而为的，交付的 JSONL 后端恰好会立即持久化每个批次）、`flush`（持久性屏障，同时把空会话实体化）以及幂等且不可取消的 `close`。一种句柄类型同时服务两种访问——在读句柄上执行修改是运行时的 `SessionReadOnlyError`，这是本代码库其他 seam 的既定惯例，而非类型层面的拆分。单写者所有权由注册表在进程内强制（`SessionAlreadyOwnedError`）；持久的跨进程租约是计划在同一形态上叠加的下一层。

**agent 生命周期负责获取句柄；后端负责事件驱动的流程。**agent-loop——会话在生产环境中唯一的发布点——在发布之前获取句柄（新建会话用 `create`，并通过它追加构造 seed；恢复用 `open(id, 'write')`），并在与排空循环相同的记忆化 teardown 中关闭它。由于持久化已保证每个会话 id 只有一个活跃写句柄，后端一次性安装会话监听器并按 id 路由：`session/event` 进入持有句柄的有界 write-behind 窗口（内部调度策略，而非配置），`session/flush` 作为持久性与错误观察屏障，`session/disposed` 作为最终排空并关闭。写路径没有任何部分跨越包边界——没有写入器组件，没有批处理配置，没有排空注册表。根 fiber 的 dispose 会并发运行每个 fiber 的 disposer，因此 `close()` 本身会经由仍然打开的存储排空已路由的缓冲；后端 teardown 的关闭清扫使应用关闭无论哪个 fiber 先解退都不丢数据。该排空只保证已发出并缓冲的事件；turn 中途的根 dispose 仍会按设计丢失该 turn 尚未发出的剩余部分——下一次恢复的 `interruptedTurnClosers` 会持久地修复这段尾部。在生命周期之外发布的会话不再隐式持久化；生产环境中没有任何地方那样做。

**语义崩溃修复移出了持久化。**恢复通过其写句柄读取物理上有效的日志，计算 `interruptedTurnClosers`，并把它们（连同构造器的 `session/end-seed` 标记）作为普通批次通过同一句柄追加——修复不是特殊的存储入口。只读观察方（session-query）仅在内存中配平被中断的冷日志，并拥有以 `stat().revision` 为键的冷 Session 缓存；持久化侧的已准备缓存与 revision 收敛循环被删除。

**可见性与新鲜度是显式的。**已创建的会话自 `create` 起即可在进程内被观察到；物理实体化（纯粹的优化）可以推迟到第一次 append 或 flush，其他进程只能看到已实体化的会话，实体化之前崩溃意味着该会话从未存在。一旦某次 append 或 flush 完成，其后在同一后端实例上开始的读取至少能观察到该前缀——这正是 `message-feedback` 持久目标检查所依赖的保证。

**revision 简化为逐实例变更令牌。**令牌相等可视为日志未变；所有权变动绝不会改变令牌。JSONL 通过一次 `fs.stat` 派生尽力而为的令牌与 `sizeBytes`；存储介质能够廉价统计事件数的后端可以改为提供 `eventCount` 提示。会话列表的冷空白探测回归到这些元数据之上（`coldBlankProbeMaxEvents`/`coldBlankProbeMaxBytes`），恢复了随路径查询一起移除的能力。

## 考虑过的替代方案

**类型化的读/写句柄类（或重载）。**不作为该 seam 的风格采纳：本代码库的 seam 偏好带访问标记的单一类型加运行时拒绝，而拆分会为一个编译期检查让每个面向消费方的类型翻倍。

**在句柄旁保留协调器的接管/HMR 写路径。**不采纳：接管的存在是为了事后猜测所有权；当生命周期显式移交句柄后，无法服务旧句柄的重载后端会向写入器响亮地失败，而不是静默地重新认领日志，而没有句柄的会话是一个由持久化缺席暴露、而非被接管掩盖的组合缺陷。

**在句柄旁提供服务级 `append(id, events)`。**不采纳：按 id 寻址的写路径绕过所有权；每次写入都流经持有句柄，使未来的租约检查恰好只有一扇门。

**由持久化持有批处理配置。**不采纳：批处理窗口是写路径内部的调度策略，而非随部署变化的选择，因此它是 provider 常量，任何地方都不存在配置旋钮。

## 后果

恢复、fork、subagent、ACP、webhook 与 SDK 会话全部经由一个显式获取点持久化，且 dispose 可证明地释放写所有权（teardown 之后重新以写模式打开可以成功）。代价：在有活跃会话时重载后端插件会使它们的句柄失效——写入会响亮地失败，直到会话重启，而以前接管会静默重连；测试中 `ctx.sessions.create` + `flush` 在没有句柄时什么也不持久化（测试通过 `create`/`append`/`close` 播种）；只有当紧邻其前没有观察读解析过同一产物时，恢复才重新读取冷日志——一个有界的 provider 内部 memo（按会话 id + stat 修订号，任何本地修改都使其失效）服务观察后提升与授权后恢复这两类交接，而不恢复已删除的 borrow/reservation 生命周期；session-query reader 自己的已准备缓存仍是其上方具备 pin 能力的一层（后续可考虑二者收敛）；空的已创建会话在显式 flush 之前对其他进程不可见（ACP 为其可恢复空会话承诺强制执行一次 flush）。`SESSION_FORMAT_VERSION` 保持为 0。

## 相关

- [作为抽象服务的会话持久化](2026-06-14-session-persistence.zh.md)——本 Note 重塑的 seam；其接口列表已反映句柄 API。
- [持久化 export() 与预发布读取路径精简](../simplification/2026-08-27-persistence-export-and-pre-release-trims.zh.md)——预备性的移除，包括本 Note 的元数据所恢复的空白探测。
- [保留可忽略的外部会话事件](2026-08-30-retain-ignorable-external-session-events.zh.md)——读取侧的拒绝约定，现经由 `storage-contract` 辅助函数共享。
- [为会话持久化写入批处理设定上界](2026-08-08-bounded-session-persistence-write-batching.zh.md)——被路由写路径作为内部调度策略保留的批处理语义。
