# Agent Note: 每个 LLM 请求都可从会话日志重建

Status: implemented

[English](2026-07-05-reconstructable-requests.md) | 中文

## 问题

请求流水线未能保证前缀稳定性以利用提供方缓存，会话日志也无法重建模型实际看到的内容。日志遗漏了模型、系统提示词和工具 schema，同时允许逐次调用的请求改写。因此缓存行为和回放等价性取决于碰巧加载了哪些插件。

快乐路径的参考形态是 MiniCode 的 `LLMClient`：一个有状态的对话客户端，随对话推进只做追加而不重建，仅在系统提示词、工具集或压缩（compaction）真正改变了模型需要看到的内容时才重置。本 Agent Note 回答的设计问题是：如何在不放弃事件溯源的前提下获得这种纪律。

## 决策

### 原则

**模型可见 ⟺ 已持久引用。** 凡到达模型请求的内容都必须能从会话日志及其引用的不可变内容寻址对象中重建。可检查的推论：任何人持有日志、日志引用的附件对象和固定代码版本，即可逐字节重建循环的每个请求。纯文本 `GenerateOptions` 仍是日志的纯函数；含图片请求还会在适配器序列化期间通过 `ctx.attachments` 解析 `ImageAttachmentRef` 字节，其中对内容摘要及已记录元数据的校验使对象查找具有确定性，并在数据缺失或损坏时明确失败。直接的一次性调用（压缩的 summarize 调用）记录其信封标量（`compaction/summary.{provider, model, maxTokens}`），其输入是对日志区域及这些引用对象的确定性代码运算——由于只有循环会标记请求归属，因此它们不在不变式内。

前缀缓存稳定性是推论 #1，而非标题：一个仅追加的日志经逐节点纯函数投影，在 header 不变时自然产出前一请求的追加扩展——稳定性是涌现的，不是管理出来的。字节精确的审计/回放是推论 #2；带*可归因*漂移的恢复与 fork 是推论 #3。

### 机制

**消息。** `Session.deriveMessages()` 带缓存：每个 surface 条目在首次出现时通过公开的逐事件函数 `deriveEventMessage(event)` 精确投影一次；surface 重写（压缩的 `replace`，即 `SurfaceManager.replaceGeneration`）触发重建。调用方每次获得一个新数组，底层是共享的深度冻结消息：通过投影变异已记录的历史是不可表达的（会抛异常），取代了旧的逐次调用克隆隔离。外部重建器对日志前缀折叠同一个公开函数，因此不可能有两条路径产生分歧。

`EpochHeader` 记录请求的非历史状态：调用配置、渲染后的系统提示词和工具 schema，空值规范化为缺失。适配器提供的推理强度与 token 默认值会保留其 `adapterDefaults` 来源信息；Web 从日志恢复模型选择时会省略适配器持有的推理强度，因此下一次解析不会把相同的有效配置重新归类为显式选择并产生虚假变更。`request/header` 始终写入完整快照：首个循环实例使用 reason `initial`，后续实例使用 `resume`，实例内变更使用 `change`，内容未变的封装显式开启消息序列或跟随表层替换时使用 `series`。如果发生变化的请求同时开启序列，`change` 快照会携带 `startsSeries: true`，无需重复 header 即可保留这两个独立事实。普通的仅追加后续 Turn、同一序列内后续的 Step 与重试沿用最新快照。`foldRequestHeader` 选择最新快照。旧的 `request/header-delta` 事件和已移除的 `fallback` reason 在追加或加载时都会被拒绝。

每个拟议步骤先领取其 inbox 批次，再运行 `agent/pre-step`。reject 不打开步骤；enter 打开 `step/start`，把最终消息批次记录为 `user/message` 事件，并可使用 `startsRequestSeries: true` 声明独立序列。随后步骤组装系统提示词与工具，`agent/request` 只能替换冻结的调用配置种子。循环记录所需的 initial、resume、change 或 series 完整快照，从派生消息与该 header 构建 `GenerateOptions`，冻结请求但保持 `AbortSignal` 活跃。[请求冻结来源证明决策](../simplification/2026-09-06-agent-request-freeze-provenance.zh.md)拥有消息完整冻结的复用规则和每次请求的本地 header 冻结规则。首次调用配置从显式的 `AgentOptions` 出发，保留 fork 覆盖和恢复重配置；后续调用从折叠后的 header 出发。

**已打开步骤是重建边界。** 进入步骤的 `user/message` 批次与任何新写入的 `request/header` 都位于请求分派之前。原子领取后发生的注入加入后续请求；必须影响本次请求的监听器则通过 `agent/pre-step` 返回消息。header 重建选择该步骤的 `request/header`，或在无新 header 写入时沿用前一个快照。

**强制执行。** `dsh-agent-loop/invariant` 配套插件向 `ctx.invariants` 注册，并在被选用时通过一个全新的 `Session` 独立重建每个循环请求，使活跃缓存无法为自身背书，然后在 `llm/stream` 处比较消息和折叠后的 header 字段。循环通过 `dsh-llm` 的 `markAgentLoopRequest()` 记录精确的冻结请求；这一进程内标识让配套插件和其他请求观察者识别对话工作，而直接的一次性调用无论其冻结形状或会话 id 如何都保持排除。正确性依赖于序列有界的重建，而非监听器顺序。带密钥的 e2e 要求首次请求之后有正值的 cache-read token；逐步骤用量是生产信号，header 变更或压缩表现为下一步骤的 cache-read 下降。

### MiniCode 形态：采纳，以事件日志为真源

与 MiniCode 相同，对话仅追加推进，仅在模型可见状态变更时重置。与 MiniCode 不同，事件日志仍是真源，因为它同时拥有持久化、恢复、边界、工具配对，并记录派生事件到其输入事件的关联。`Session` 缓存从日志推导的消息和 header 折叠结果，使每个请求都可独立检查。

## 曾考虑的替代方案

- **客户端作为真源**（照搬 MiniCode）：在日志之外多出一个运行时真相——两者漂移而无人察觉；见上节。
- **镜像日志的有状态传输客户端**：重复对话状态，需要围绕监听器做回滚，留下未记录的编辑路径，且仍无法重建请求 header。Session 拥有的缓存加已记录的 header 避免了这些分裂的真相。
- **逐次调用的请求标量**（一个可自由变异的配置传给每次 `agent/request` 分发）：监听器可以零记账地逐次切换模型，悄然放弃本设计旨在保护的提供方缓存。配置是逐对话的已记录状态；waterfall（瀑布式事件）提议，日志记录。
- **检测并报告**（比较连续请求，发散时告警）：事后捕获违规；违规请求仍可构造并发出。因违规必须在接口层面不可表达而否决。
- **事件驱动组装**（仅在变更信号时重新渲染）：存在漏信号的 bug 类别——会话中途注册的工具发出 `tools/change` 而非 `system-prompt/change`，第三方提供方可能什么都不发。逐步骤渲染加值比较在零信号纪律下即可稳健工作。
- **自定义 header-delta 编解码器**（系统行编辑、按名称键控的工具编辑、完整配置/前缀替换）：减少了重复字节，却复制了表示及其 diff/apply/fallback 机制。完整快照只保留一种回放表示。
- **引用前一个 header 的轻量 series 标记**：减少重复的提示词与工具字节，但从该标记开始的窗口若不再读取前序，就无法渲染或重建请求。自包含的完整快照让持久化、局部历史和快照固定共用一种表示。
- **Header 快照上的叙事性变更字段列表**：可以通过比较连续快照推导。`reason` 仍保留，因为实例边界无法从快照值推导。

## 后果

- 一个日志无法解释的请求不可能被意外构造——无论是循环还是监听器；变异已构建的请求会抛异常；每个 header 变更都是持久的、可 diff 的日志事件。
- 模型可见上下文使用已记录消息通道。`agent.inject()` 与工具 `additionalContexts` 进入 inbox，等待后续领取；必须与当前已领取批次一起结算的上下文由 `agent/pre-step` 返回。每个进入步骤的值都是带来源的持久 `user/message`，只付出一次代价并在后续成为可缓存前缀，代价是会在历史中累积直至压缩。
- 在提供方处仍需全价计算的内容是固有的且已记录的：压缩（其 `compaction/*` 事件和替换条目）、真正的提示词、工具或配置变更（reason 为 `change` 的 `request/header`），或带漂移的进程边界（不同的 `resume` 快照）。提供方自身的 reasoning-content 排除由服务端管理。
- `agent/pre-step` 是当前请求的消息通道；直接修改 inbox 则是最终进入后续请求的通道。
- 工具结果裁剪无需新机制：一个已记录的单条目 surface replace（`start === end`），携带同一 `callId` 下裁剪后的 `tool/result`——属压缩家族，回放正确，缓存失效由相同的压力逻辑批量处理。
- 无法读取的被引用附件对象仍会让模型请求失败；[附件自动隔离](../../proposed/bug-fix/2026-08-20-attachment-read-quarantine.zh.md)记录了不削弱字节精确重建的拟议恢复方案。
- 会话日志会为每个循环实例、真实变更和后续模型消息序列增加一个 `request/header` 快照。重复完整系统提示词与工具目录比 delta 编解码器更大，但相对分片密集型日志仍然很小，并保留一种自包含的回放表示。当前 v1 保留这一种表示；冻结的 v0-to-v1 迁移边会在构造当前 Session 前显式拒绝旧版 delta 事件。
- 快照 fixture 包含每个重复的 series header。无密钥 refresh 负责这些确定性日志变化；快照 harness 只为 initial 与真实 change 修订固定提示词和工具 sidecar，并让 `series` 快照复用当前修订。写入文件系统的 fixture 继续以规范化的撰写形式存储，工具参数使用 cwd 相对路径，因为回放只对 cwd 无关的参数路径做往返。
