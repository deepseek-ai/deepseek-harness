# Agent Note: 会话持久化作为基于现有 `SessionEvent` 的抽象服务

Status: implemented

[English](2026-06-14-session-persistence.md) | 中文

## 问题

会话此前仅存在于内存中。示例插件 `session-jsonl.ts`（在两个示例中逐字节重复）是只写的遥测：它缓冲 `session/event` 并追加 JSON 行，没有读取/回放路径，没有崩溃安全性（无 fsync、无原子写入、dispose（资源释放）时采用 fire-and-forget 方式排空），没有列表功能，也没有格式版本控制。没有任何机制能将磁盘上的历史会话重新注入到活跃的 agent（智能体）中，因此持久恢复、持久 fork 以及宿主侧的会话浏览都无法实现。

[事件溯源模型](2026-06-11-event-sourced-sessions.zh.md)将仅追加日志作为唯一真源，并从中派生 LLM（大语言模型）历史。持久化必须忠实于这一设计：直接持久化现有的 `SessionEvent`，不引入需要来回转换的并行「持久化消息」类型。后端也必须可替换——当前用文件存储，以后用数据库存储——并由同一接口封装。

## 决策

持久化是一个具有抽象 Service Definition 的**能力 seam**（[能力 seam](2026-06-13-capability-seams.zh.md)，`dsh-shell` 模板），而非循环或核心逻辑：

1. **接口**（`dsh-session-persistence`，`ctx.sessionPersistence`）：一个抽象的 `SessionPersistence` 服务，提供 `create`/`open`/`stat`/`list`/`flush`，其中 `create`/`open` 返回逐会话的 `SessionHandle`，句柄承载 `read`/`append`/`flush`/`close`（[基于句柄的 seam](2026-08-27-handle-based-session-persistence.zh.md)）。其持久化单元就是现有的 `SessionEvent`（`{ type, seq, time, data }`），原样复用，无转换类型。
2. **实现**（`dsh-session-persistence-jsonl`）：每个会话一个仅追加的逻辑 JSONL 日志：先是一行 `SessionHeader`，随后是无损表示连续 `SessionEvent` 流的存储记录。当前 v2 每个事件写一行；冻结的 v0 与 v1 reader 保留其历史 packed-delta 表示。[带校验和的 Zstandard 帧](2026-07-19-zstandard-jsonl-session-logs.zh.md)是默认物理编码，也可通过配置使用原始行。

长期有效、存在争议的关键选择：

- **规范持久日志无损保留每个当前 `SessionEvent`。** 在 v2 中，一个 `assistant/message` 或 `assistant/attempt` 会嵌入该 attempt 的精确带时间 provider stream；`deriveMessages()` 只投影 surface message。删除嵌入 stream 成员看似诱人，但会丢失 replay、timing、usage、部分失败与诊断事实。移除完整事件同样需要密集重新编号，因为 `seq = log.length` 且 `events[i].seq === i`；[v1 到 v2 迁移](2026-09-01-v2-embedded-assistant-streams.zh.md)会显式执行该改写，而不是过滤规范日志。
- **仅追加；崩溃的轮次被关闭，而非截断。** 已刷写的事件永不被重写。[语义检查点策略](../../../../packages/session/session-checkpoint-policy/README.zh.md)会在调用模型前排空请求、在调用工具前排空已记录的顶层调用，并在步骤结束后排空完整的响应/结果批次；循环则排空最终轮次边界。由于一个被中断的轮次可能包含大量有效工作，持久化会原样返回其连续、可解析的事件；配平是读方的职责——resume 会为未应答的 assistant 调用计算按风险分类的错误结果、补一个缺失的 `step/end`，以及带 `{ kind: 'interrupted' }` 的 `turn/end`（`interruptedTurnClosers`），并通过其写句柄追加它们，而只读观察方仅在内存中添加同样的收尾事件。合成结果保证恢复后的提供方 transcript（文本记录）仍然有效。只有撕裂的最终 append 中不完整的碎片会被丢弃——从中恢复的完整记录由写路径在第一次新 append 之前持久重写；已提交前缀中的解析错误或序号间隙，属于数据损坏，会使该会话不可加载。
- **文件后端为规范实现，服务保持可扩展。** `dsh-session-persistence-jsonl` 是唯一 first-party provider，并通过 `runPersistenceContract`；抽象服务继续供仓库外 provider 使用。[JSONL-only 持久化决策](../simplification/2026-08-30-jsonl-only-session-persistence.zh.md)负责 first-party 数据库 provider 的删除及其明确 compatibility cut。
- **元数据在日志之外。** 格式版本、cwd 和谱系是存储关注点，不是可回放的对话状态，因此它们存放在 `dsh-session` 拥有的 `SessionHeader` 中，并通过新的只读属性 `session.header` 附加到 `Session` 上——永远不进入 `SessionEventMap`，永远不到达 `deriveMessages()`。`createdAt` 是以 Unix epoch 毫秒表示的非负安全整数：运行时创建和持久化注册会拒绝小数值，JSONL 会验证解码后的 header。替代方案（一个可合并扩展的 `session/meta` 事件作为日志第 0 行）被否决：日志内事件会自然随 seed/fork 的会话携带，但元数据不是可回放状态，因此显式的日志外 header 边界是更清晰的取舍。（header 最初被拆分为不可变的 `SessionHeader` 加可变的 `SessionSummary`，二者的联合类型为 `SessionMeta`；可变 summary 后来因属于死状态而被移除——见 [移除可变会话摘要](../../archived/simplification/2026-06-19-drop-mutable-session-summary.md)。）
- **`ctx.agents.create()` 和 `ctx.agents.resume()` 是异步工厂；恢复还跨越持久化边界。** `ctx.agents.resume({ resumeSessionId })` 打开该会话的写句柄，读取已存储的日志，并以持久化 id 发布准备好的 Session，继续其投影。[Session 准备阶段决策](../../archived/architecture/2026-08-05-session-preparation.md)定义未发布 Session 的所有权窗口。agent loop（智能体循环）不会硬注入 `sessionPersistence`（那样会让非持久化的演示永远挂起）；当它不存在时，`resume` 会以明确的错误拒绝。

## 曾考虑的替代方案

上述每个关键选择都在陈述处记录了被否决的替代方案：**过滤 stream 的规范日志**会丢失 attempt 证据，而未通过显式迁移移除事件会破坏连续序号；**截断崩溃的轮次**会静默销毁长时间自主运行中的真实工作；**日志内 `session/meta` 事件作为第 0 行**——元数据不是可回放状态；**有限的非整数 `createdAt` 值**没有生产方，且与整数 Unix 毫秒存储不一致；**将 `sessionPersistence` 硬注入循环**会让非持久化的演示永远挂起。

格式版本控制：header 携带 `version`；句柄只暴露 `SESSION_FORMAT_VERSION = 2`。JSONL 的事件正文读取会在返回句柄前组合静态 v0-to-v1 与 v1-to-v2 相邻迁移链；第一条边负责有界 legacy normalization，第二条边负责 Assistant stream 嵌入与密集引用重映射。V0 保留无后缀的 `session.jsonl[.zstd]`，正版本则使用不可变的小写 `session.vN.jsonl[.zstd]` 名称（[已发布 Session 迁移](2026-08-31-released-session-format-migrations.zh.md)）。当前 generation 的 append 与 flush 能稳健处理不完整尾部写入；未来 provider 或 WAL 必须定义自己的断电与恢复约定。

## 后果

Service Definition、JSONL provider 与 `dsh-session` 中的元数据约定（`session.header`，`create(header, options?)` 签名）带来持久恢复/fork、读取/replay 路径、崩溃容忍，以及基于现有事件溯源日志的宿主侧 Session 访问。可复用 `runPersistenceContract` 测试套件以相同的仅追加、连续 seq、惰性物化、逻辑恢复、整数元数据与可序列化语义约束该 provider 与未来实现。持久化完整逻辑日志也确定了事件保真度：每个 Assistant attempt 都在一个持久 settlement 中保留其精确紧凑带时间 stream。
