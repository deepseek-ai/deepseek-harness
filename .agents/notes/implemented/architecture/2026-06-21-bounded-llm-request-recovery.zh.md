# Agent Note: LLM 暂时性请求失败的有界恢复

Status: implemented

[English](2026-06-21-bounded-llm-request-recovery.md) | 中文

[按提供方配置的请求重试策略](../feature/2026-07-24-provider-retry-policies.zh.md)在此基础上增加了确切提供方配置与显式无界 mode。本说明继续负责结构化失败事实、失败尝试的恢复边界、normal mode 的暂时性默认值、可见的单次尝试和持久重试状态。[LLM（大语言模型）流的终止失败](2026-07-29-terminal-llm-stream-failures.zh.md)取代了其中关于抛出错误身份和流 sidecar 的机制。

## 问题

提供方适配器可能在分发或迭代时抛出异常，也可能以 `finish { kind: 'error' | 'aborted' }` 结束。最终适配器边界会在 `dsh-agent-loop` 接收前把抛出值规范化为该终止 finish 协议；middleware 与结果处理缺陷仍会抛出。loop 会将终止模型请求失败交给 `agent/request-error`。未被处理的失败是终态；处理失败的监听器修复策略自有状态，返回 `{ kind: 'retry' }`，并停止 waterfall（瀑布式事件）委托。[重试动作决策](../simplification/2026-07-27-request-error-retry-action.zh.md)规定这一返回约定。

该边界已能安全地再次发起请求。每个失败 stream 会提交一个包含精确紧凑 stream 的仅日志 `assistant/attempt`，message derivation 会忽略它；系统只会在 terminal finish 成功并组装 `assistant/message` 后分派工具调用，重试则从持久 surface 重建下一次 attempt。因此，harness 无需引入第二套响应生命周期或暂定输出协议，即可分隔两次 attempt。

此前的边界还留有三个较窄的缺口。

- 提供方失败只保留消息，通常还会保留一个 code。HTTP 状态、重试延迟和提供方请求 id 会被丢弃，或者只能通过提供方专用错误对象恢复，因此通用恢复机制如果不解析文本，便无法作出决策或解释决策。
- 重试的归属因适配器而异。手写 DeepSeek 适配器只尝试一次，pi-ai profile 则可以启用库内部的不透明重试。如果把隐藏的传输重试与 `agent/request-error` 监听器结合，尝试次数会成倍增加，中间失败也不会记入会话日志。
- 恢复后的失败没有持久状态事实。失败的步骤和分片仍可重建，但观察者无法得知 agent（智能体）是否在有意退避、将等待多久，以及等待原因。长时间的静默等待看起来与循环停滞无异。

默认策略的目标是从同一个显式提供方／模型请求的暂时性失败中进行有界恢复。提供方或模型故障转移、响应拼接和语义输出修复都属于其他问题，目前没有消费方。

## 决策

### 保留失败事实，不嵌入策略

`@deepseek-ai/dsh-llm` 导出唯一的可 JSON 序列化 `LlmFailure` 载荷：

```ts ignore-check
type ProviderRequestId = Branded<'ProviderRequestId'>

interface LlmFailure {
  message: string
  code: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: ProviderRequestId
}
```

`code` 仍是 `HarnessError` 建立的 provider-neutral 机器路由分类；新字段是在 provider 边界观测到的事实。`ProviderRequestId` 由 `dsh-llm` 拥有并构造，序列化后是 provider 发放的字符串。该 payload 有意不包含 `retryable`、`failover`、`partialOutput`、provider、model、phase 或 route id。是否可重试属于 policy，provider/model 已位于持久 request header 中，部分输出由失败 attempt 的嵌入式 stream 保留。

`LlmError` 携带 `failure: LlmFailure`，并保持 `failure.code === error.code`。`FinishReasonMap.error` 和 `FinishReasonMap.aborted` 携带同一载荷，而不是并行的失败形状。最终适配器边界会从适配器抛出值中分离这些事实，并发出相应的终止 finish；未知 SDK 异常会获得 `UNKNOWN` 载荷。精确的抛出对象身份不会跨越 LLM 流 seam。

agent loop（智能体循环）会将终止 finish 的 `LlmFailure` 传给 `agent/request-error`，并在记录未恢复的 `turn/end.reason` 时使用同一载荷。

适配器会先提取结构化事实，再回退到消息检查。它们会验证 HTTP 状态，将 `Retry-After` 的秒数或日期解析为正的有限毫秒延迟，在提供方公开请求 id 时将其品牌化，并区分自身超时与调用方中止。提供方专用 code 和消息可以细化映射，但恢复监听器不会解析它们。

共享的暂时性 code 集有意保持很小：适配器针对 `RATE_LIMIT` 和 `SERVER` 的映射，远程失败使用的显式 `TIMEOUT` 和 `TRANSPORT` code，以及提供方响应已完成却没有内容块时使用的 `EMPTY_RESPONSE`。两个适配器都会把最后一种情况归类为错误 finish；详见[空模型响应可重试](../bug-fix/2026-07-24-empty-model-response-is-retryable.zh.md)。身份验证、配额、无效请求、上下文溢出、协议、中止和未知失败都保留不同的稳定 code，且默认不属于暂时性失败。新增 code 需要适配器 fixture（测试前置数据）和已记录的策略决策；无需扩展第二个失败类枚举。

### 将重试策略放在现有失败步骤扩展点上

`@deepseek-ai/dsh-llm-retry` 是监听 `agent/request-error` 的函数插件。它不引入服务或新的循环分支；agent-loop 包仅会更改通过现有失败步骤恢复控制流携带的数据。

`agent/request-error` waterfall 携带当前 `LlmFailure`、在连续恢复序列中授权重试的不可变先前失败列表，以及提供服务的注册项所携带的不可变重试策略。循环只传递而不解释该策略；它拥有连续失败历史，并在模型请求成功后清除。`dsh-llm-retry` 的 normal 策略统计由同一项确切提供方策略安排的持久重试记录，`dsh-compaction-basic` 则维护自己的上下文溢出预算。因此，暂时性失败与上下文溢出交替出现时，会各自独立消耗其有限预算；最大请求数等于 1 加上所有已加载有限预算之和。

当前配置形状由[提供方策略决策](../feature/2026-07-24-provider-retry-policies.zh.md)规定。提供方适配器会注册嵌套的 `retryPolicy`；省略时使用 normal 默认值：两次暂时性重试、500 毫秒初始延迟、10 秒延迟上限、10% 抖动，以及上述五个暂时性 code。计数与延迟边界参考了所调查实现中较保守的一端：[OpenCode 使用两次请求重试，延迟边界为 500 毫秒／10 秒](https://github.com/anomalyco/opencode/blob/9976269ab1accfc9f9dc98a4a688c516934de422/%70ackages/llm/src/route/executor.ts#L36-L39)；[Pi 将三次 agent 级重试与提供方重试分开，且提供方重试默认为零](https://github.com/earendil-works/pi/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/%70ackages/coding-agent/docs/settings.md#L139-L147)；[Codex 使用有限请求／流预算以及五分钟空闲超时](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/model-provider-info/src/lib.rs#L25-L33)。10% 抖动参考 [Codex 的有界抖动](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/codex-client/src/retry.rs#L40-L47)。

对于预算未耗尽的合格失败，从 1 开始的暂时性重试计数使用有界指数退避。有效的 `providerRetryAfterMs` 只有在不超过 `maxDelayMs` 时才会取代指数退避；提供方延迟更长时，系统会委托给下一监听器，而不会违反提供方指令提前重试。本地退避乘以 `[1 - jitterRatio, 1 + jitterRatio]` 内的注入随机因子，并将最终值限制到 `maxDelayMs`；提供方延迟不加抖动。

插件拥有一个覆盖其整个生命周期的 `AbortController`，并跟踪每个活跃的恢复回调，包括委托的 waterfall 工作与退避。effect 的 dispose（资源释放）会先注销监听器，再中止并等待活跃回调；中止会胜过较晚到达的委托重试决策，被捕获的回调在插件 dispose 后既不能重试，也不能进入其 waterfall 的剩余部分。尽管 Cordis 已捕获该监听器，此设计仍能使 HMR（热模块替换）的 dispose 达到完全停稳。

休眠前，`dsh-llm-retry` 会追加一条不进入表层的 `llm/retry` 会话事件，其中包含轮次、失败步骤、提供方、策略 mode、完整的解析后策略 key、提供方策略重试编号、特定于 mode 的有限上限（如有）、计划延迟和 `LlmFailure`。该 key 会对 code 集排序，并在提供方路由被行为不同但 mode 相同的策略替换时分隔重试历史。该插件拥有 `SessionEventMap` 声明合并，并通过其浏览器安全的 `./types` 子路径导出载荷；`dsh-session` 继续负责通用持久化，不会吸收可选策略的词汇。事件记录已安排的内容，而不是下一个请求已完成；延迟期间取消随后会在 `turn/end` 中可见。因为该事件的目的是表示运行状态，而不是收集跟踪数据，所以它会与生产渲染器及回放／快照覆盖一起交付。

对非暂时性 code、耗尽的策略预算或超出上限的提供方延迟，监听器会调用 `next()`。这保留了与上下文溢出恢复及后续策略插件的组合能力。对自身处理的失败，它会记录并等待延迟，然后在不委托的情况下返回 `{ kind: 'retry' }`。轮次取消和插件 dispose 会结束等待且不返回重试动作，此后仍以循环的取消／dispose 检查为准。

`dsh-base` 与 `dsh-sdk-minimal` patch 将该插件作为显式配置行加载，因此基于 base 的 profile 与独立 SDK profile 使用同一套按提供方路由的策略。库消费方仍需显式组合插件：省略该插件时，请求失败保持终态。

### 由单一层负责可见的尝试

适配器每次调用 `stream()` 只执行一次提供方请求。pi-ai 适配器移除公开的 `maxRetries` 和 `maxRetryDelayMs` profile 字段，并禁用库内部重试；手写适配器保持现有的单次尝试行为。这样既避免 SDK 预算成倍放大 agent 预算，又能确保每次暂时性重试都由其记录在案的失败尝试加 `llm/retry` 表示。

`ctx.llm.stream()` 仍是原始的单次尝试 waterfall。压缩（compaction）摘要等直接调用方会收到结构化失败，但不会自动获得重试，因为它们没有 agent 步骤边界，也没有可供分隔尝试的通用持久位置。未来的直接调用消费方可能会需要一个缓冲辅助函数，仅在尚未发出任何分片时重试；本决策不增加此类辅助函数。

### 在能够终止停滞流的位置施加边界

每个适配器都公开一个经过验证的 `streamIdleTimeoutMs` 配置字段，默认值采用上文引用的五分钟先例。该间隔不超过 Node 的最大定时器延迟，因此不会被钳制为 1 毫秒。它覆盖每个尚未完成的迭代器 `next()`：从消费方请求下一项开始，到适配器识别到提供方活动为止；消费方在两次 `next()` 调用之间花费的时间不属于提供方空闲时间。DeepSeek SSE（Server-Sent Events）注释计为传输活动，但绝不会成为 `StreamChunk` 值或会话日志事件。

`@deepseek-ai/dsh-timeout` 公开一个可重新布防的空闲看门狗原语。一个稳定的局部 `AbortController` 会与调用方信号融合，并在整个适配器调用期间传给传输层；每个尚未完成的 `next()` 都会布防看门狗，该调用完成时解除布防，下一次请求数据时再重新布防。带外传输活动会调用 `pulse()`，在不产生值的情况下为尚未完成的需求重新布防。超时会使用能力自身拥有的 `TimeoutReason` 中止这个稳定控制器，`finally` 则会清除定时器。适配器将自身看门狗归类为 `TIMEOUT`，将更早发生的上游中止归类为 `ABORTED`。现有的一次性 `deadline()` 不会被描述为滑动计时器。

边界测试证明两个实际传输层都能终止。手写适配器会中止其 fetch／reader，pi-ai 适配器会把稳定信号映射到 SDK，并证明 SDK 会关闭响应。如果定时器只拒绝消费方 promise，却让请求继续运行，就不满足此约定。

### 在现有日志中分隔尝试

失败 attempt 会追加带嵌入式 stream 的 `assistant/attempt`，但绝不追加 surface `assistant/message` 或分派工具。重试在失败 turn 与 step 内继续，从持久 surface 重建请求，并产生自己的 settlement；只有最终结果才会关闭 turn。step 打开时，UI 可以渲染瞬态 `assistant/live-chunk` update；当 `llm/retry` 标识失败 attempt 或 `turn/end` 记录失败时，UI 再结算它。Web 会校验完整 retry payload contract，把每条 producer-correlated `retryId` chain 投影为稳定一行并更新到最新 attempt，再从 `llm/retry-started` 与所属 turn、step boundary 的关闭派生 scheduled、started 或 cancelled 状态。倒计时以浏览器收到 event 的时刻为计划延迟起点，而不是 Host event clock；它按向上取整且不低于 1 秒的秒数显示，只在未结算时动画，并把最新失败详情折叠在该行后。即使失败 attempt 没有 surface Assistant node，retry node 也会锚定自己的 trajectory turn。Message derivation 会忽略 `assistant/attempt`，Web 在历史重建时应用同一投影，因此刷新不会把失败 partial 提升进模型历史，也不会生成重复 retry row。

如果恢复预算耗尽，最终失败会连同结构化事实在 `turn/end.reason` 中存储一次。Web 会在该序列位置派生一个 `turn-error` 节点，并内联渲染适合展示的消息与可选错误码；AUTH 投影会把可能回显凭据片段的提供方文案替换为 `API key is invalid`，原始诊断仍保留在会话日志中。实时事件和历史回放使用同一套折叠逻辑。暂时性恢复继续期间，`llm/retry` 是每次中间失败与延迟的持久归属位置；终态错误行只在 `turn/end` 记录错误后才存在，而由于耗尽的恢复与失败共享同一轮次，该轮次的重试历史绝不会抑制这一行——定格的重试链与终态错误并列渲染。本决策不增加独立的最终错误事件或响应 id 词汇。

## 不在范围内

- 自动提供方或模型故障转移。请求已显式选择一个提供方和模型，提供方注册表也有意规定每个提供方只由一个适配器负责。
- 在成功的终止性 finish 后重试或继续，或将两次尝试的分片拼接成一条 assistant 消息。
- 修复格式错误的工具参数、拒答、内容过滤或其他语义模型输出。
- 熔断器、共享提供方健康状态或跨 agent 重试预算。
- 在没有生产消费方的情况下，把 `llm/stream` 改造成响应生命周期或增加便利的生成 API。

## 考虑过的替代方案

- **在 `llm/stream` 或提供方 SDK 内部重试**：拒绝采用，因为原始流一旦发出分片便没有持久尝试边界，隐藏的 SDK 重试会成倍放大预算，而且两条路径都无法一致地记录每次失败尝试。
- **向 `dsh-llm` 增加响应开始、中断、丢弃、失败和提交事件**：拒绝采用，因为 agent 日志已经分隔原始分片、成功消息和编号尝试。第二套状态机会重复归属关系，又不能支持有界的同路由重试。
- **增加逻辑路由、能力矩阵和故障转移选择**：拒绝采用，因为当前请求已经显式指定提供方和模型，每个提供方由一个适配器负责，而且没有当前消费方要求自动回退或能够证明语义兼容性。
- **把 `retryable` 或 `failover` 放在 `LlmFailure` 上**：拒绝采用，因为适配器报告事实，部署策略决定动作。同一个 429 可以在交互式组合包中重试，也可以在成本受限的批处理中被拒绝。
- **只要调用方仍处于活跃状态就无限重试**：[按提供方配置的策略](../feature/2026-07-24-provider-retry-policies.zh.md)对显式 `always` 配置项推翻了这项拒绝，同时保留有界的 normal mode 作为默认值。
- **只通过进程 logger 记录重试状态**：拒绝采用，因为进程日志无法重建会话行为，也不能驱动回放后的 UI 状态。
- **只保留扁平 code**：拒绝采用，因为重试延迟和提供方请求 id 是结构化的提供方事实，而当不同协议失败共用一个稳定 code 时，诊断还需要 HTTP 状态。

## 验证

- `LlmFailure` 是适配器抛出、错误 finish 和中止 finish 使用的唯一可序列化载荷；在可用时，规范化保留稳定 code、状态、重试延迟、品牌化的提供方请求 id，以及调用方中止与适配器超时之间的分类。
- 适配器抛出值会在抵达消费方前成为终止失败分片；middleware 与消费方异常仍在模型请求恢复之外抛出。
- DeepSeek 和 pi-ai 适配器测试覆盖具有代表性的 400、401/403、429、5xx、连接、格式错误／截断流、超时、中止、Retry-After 秒数／日期、请求 id 和未知 SDK 错误路径，恢复策略无需解析消息文本。
- pi-ai 将 SDK 选项固定为零次重试，并针对可重试的提供方响应执行一次可观测的线路请求尝试；独立测试确保移除任一边界都会失败。
- `agent/request-error` 携带当前失败事实、不可变的先前已重试失败事实，以及提供服务的注册项所携带的不可变重试策略；成功会清除历史，暂时性失败／上下文溢出交替发生的集成测试证明两种策略只消耗各自的有限预算。
- 每个提供方适配器都在 Loader 启动时验证其嵌套重试策略，`ctx.llm` 则将该策略与路由一同捕获；normal mode 会委托不合格路径，而且在没有其他策略时最多发起 `maxRetries + 1` 次提供方请求。
- 退避期间执行 HMR 的测试证明：dispose 过程会注销监听器、中止并等待其捕获的回调，dispose 后不发出重试决策，也不留下存活的定时器或 promise。
- 纯单元测试覆盖暂时性 code 选择、指数退避和抖动边界、有效及超出上限的 `Retry-After`、耗尽的预算、确定性定时器／随机数钩子，以及退避期间中止。
- 真实 agent-loop 测试覆盖分片前失败、部分分片后失败、抛出及带内失败、在同一轮次内重试至成功、耗尽后写入结构化 `turn/end.reason`，以及与 `dsh-compaction-basic` 上下文溢出恢复的组合。
- 部分分片集成测试证明：失败分片仍归属于失败步骤，该步骤不会提交 assistant 消息或工具副作用，成功的重试会记录自己的分片 seq 和提供方／模型路由。
- 插件拥有的不进入表层的 `llm/retry` 事件可在 JSONL 往返后保留，被消息派生忽略，并驱动 TUI 和 Web 撤回及计划重试渲染。客户端测试覆盖完整的 wire 验证、独立于时钟的倒计时、已取消与已完成重试标签的区别以及轨迹归属；无密钥 UI 快照覆盖 Web 的调度与成功，真实 Web 组合测试覆盖部分传输失败直至恢复，以及耗尽后终态错误行与定格重试链并列的画面，ACP 自动化快照确认，被丢弃的尝试不会通过协议发出，而恢复后的回复会正常发出。
- 空闲看门狗测试证明：只有 `next()` 尚未完成时才会重新布防稳定信号；在消费方思考期间及 `finally` 中会解除布防；它与总调用 deadline 以及更早发生的调用方中止分开分类。适配器测试证明该信号会终止底层请求，而不只是与其脱离。
- `ctx.llm.stream()` 的直接调用方仍只尝试一次，并收到相同的结构化失败事实。

## 后果

- 每次重试尝试都在其所属轮次内以失败尝试的分片加 `llm/retry` 的形式可见，适配器级的单次尝试行为会防止隐藏的 SDK 重试成倍增加策略决策。即使没有分片到达，重试仍可能造成提供方重复计费；normal mode 会限制此风险，而显式 always mode 会接受它，直至取消或成功。
- 提供方 SDK 可能隐藏状态或重试标头。适配器会保留 SDK 公开的稳定事实，否则使用粗粒度 code，而不会让恢复策略解析脆弱的文本。
- 持久重试事件扩展了会话协议和 UI 状态机。事件与其消费方一同交付，可避免产生无人使用的遥测词汇；但以后更改 schema 仍需要同步完成持久化和回放工作。
- 清除失败步骤的实时分片可能会明显撤回输出。与把丢弃的文本或不完整工具 JSON 呈现为已提交历史相比，这是更好的选择；快照固定这一转换。
- 适配器局部的空闲强制机制可以终止停滞的传输，而不会计入消费方思考时间。每个传输边界的约定测试会防止 SDK 漂移。
- 多个 normal 恢复插件会叠加各自的有限预算。always mode 会先委托，再提供无界回退；重叠的分类器仍会形成依赖注册顺序的策略，必须由引入它们的插件记录并测试。

## 相关资料

- [结构化错误分类体系](../../implemented/architecture/2026-06-11-structured-error-taxonomy.zh.md)负责稳定、可供机器路由的 code 与 cause chaining。
- [可重建请求](../../implemented/architecture/2026-07-05-reconstructable-requests.zh.md)使提供方／模型和完整请求输入在分发前持久化。
- [超时 deadline 库](../../implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)将共享的 deadline 分类与能力自身拥有的终止操作分开。
- [调用后压缩压力与上下文溢出恢复](../../implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md)负责当前已关闭步骤的请求恢复扩展点与有界溢出重试。
- [提供方路由的 LLM 适配器](../../implemented/architecture/2026-07-14-provider-routed-llm-adapters.zh.md)负责显式提供方／模型路由与每个提供方仅有一个适配器的不变量。
- [Terminal turn errors survive same-turn retry history](../bug-fix/2026-08-20-turn-error-survives-same-turn-retry-history.zh.md)负责移除曾藏掉耗尽恢复终态错误行的 Web 重试历史抑制。
