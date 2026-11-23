# Agent Note: 在会话事件提交时折叠运行结果

Status: implemented

[English](2026-11-20-fold-run-results-as-session-events-commit.md) | 中文

## 问题

有两种运行结果是根据一个运行区间内的事件推导出来的。本地 subagent 后端根据一次 activation 的事件选出 `SubagentResult.output` 并推导 `stopReason`。headless runner 根据一次调用的事件选出最终文本和最后一个 `turn/end` 的原因，它们成为 stdout 和退出码。

在结算时从会话日志重读这个区间，属于[已弃用的同步历史读取](2026-09-09-deprecate-synchronous-session-event-reads.zh.md)。它要求区间内的每个事件在结算前都留在内存中，而 continuable 子会话的区间没有大小上限。

headless runner 还会扫描整个日志，以得知它用 `--session-id` 沿用的 Session 当前运行在哪个 agent preset 下。

这两个结果都不是之后的进程需要恢复的状态。`SubagentResult` 只产生一次，由运行该 activation 的进程在 `finishDisposal` 内产生。它的消费方都在该进程内：activation 回执、`subagent/end`，以及写入父日志的结算通知。没有任何 API 为不驻留的子会话返回结果。冷恢复开始的是一次新的 activation，更早的进程写入的事件不属于它的结果。headless runner 只输出本次调用自己的结果。

## 决策

两处读取方都在每个事件提交时折叠它，结算时读取折叠后的状态。`session/event` 监听器在 `Session.append` 内、事件进入日志之后同步运行，所以在整个区间内保持注册的监听器收到的事件，恰好是读取该日志后缀会返回的事件。会话事件、公开的结果类型和模型可见文本都不变。

### 本地 subagent 后端

[`SubagentManager`](../../../../packages/subagent/subagent/src/manager.ts) 在构造时于其 activation-owner scope 上注册一个全局的 `session/event` 监听器。监听器之所以是全局的，是因为带 scope 标签的监听器只会收到自身 scope 及其下级 scope 中 Session 的派发，而子会话可能运行在管理器 context 不在其中的 preset scope 下。对于驻留的本地子会话的 Session 事件，监听器调用 `foldLocalResult`，推进保存在 activation 上的两个折叠：一个 `AssistantOutputFold` 和一个 `foldConsumedWorkForEvent` 状态。materialization 在 `agents.create` 或 `agents.resume` 之后的同步区段内创建这两个折叠，所以折叠从 activation 开始时的 Session offset 起算。`captureLocalResult` 读取它们。

`session/event` 的派发会记录并丢弃监听器的异常。因此 `foldLocalResult` 保留每个折叠抛出的第一个错误并停止该折叠，`captureLocalResult` 重新抛出它：先是输出折叠的错误，然后是停止原因折叠的错误，除非已有实时失败决定了停止原因。activation 结果以该错误被拒绝。

监听器注册在 activation-owner scope 上，是因为两个更近的 context 都会漏掉事件：

- **子 scope。** `AgentLoop` 的 teardown 依次取消 Agent、等待空闲、释放子 scope，然后发出 `agent/disposed`。当子会话由其他所有者释放时，管理器在自己的 `agent/disposed` 监听器内获取结果。此时子 scope 上的监听器已被移除，所以结果会缺少子 scope 的 disposer 追加的任何事件。被取消轮次的 `turn/end` 在该 scope 被释放之前提交。
- **管理器 context。** fiber 卸载时同时启动该 fiber 的所有 disposer，所以管理器 context 上的监听器被移除时，`drain()` 仍在等待它取消的子会话。activation-owner scope 的 disposer 在 `drain()` 完成之后才运行。

### Headless runner

[`run`](../../../../packages/bundle/headless/src/index.ts) 在提交任务之前于其 Agent 的 scope 上注册一个 `session/event` 监听器，并在其中折叠该 Agent 的 Session 的每个事件。`run` 不归插件 fiber 所有：进程树在运行期间被释放时，插件 context 上的监听器在被取消的轮次提交其中断的 `assistant/message` 和 `turn/end` 之前就被移除，而 `run` 随后会越过 `agent.whenIdle()` 继续执行。Agent 的 scope 在 Agent 空闲之后才被释放。`run` 在同一个同步区段内记下 Session offset，折叠忽略低于该 offset 的事件，所以区间由折叠自身给出，不依赖监听器的注册时机。区间内的规则是：忽略第一个 `turn/start` 之前的事件；`turn/start` 清空原因；非空的 `assistant/message` 文本替换文本；`turn/end` 设置原因。监听器保留折叠抛出的第一个错误，`run` 在读取结果的位置重新抛出它，即在 flush 和实时失败检查之后。

### Headless 沿用检查

`dsh-headless` bundle 启用 `dsh-base` 提供的 [agent preset 注册表](../../../../packages/preset/agent-preset-registry/README.zh.md)，保留前序组合包配置的默认值。注册表维护 `agentPreset` projection：header 中创建时的 preset，被每个 `agent-preset/selected` 事件替换。runner 拒绝沿用 projection 值不为 `null` 的 Session。它从 resume 之前取得的 observation 读取该值，并在以下三处从 `agentPresets.presetForSession` 读取：同 id 的存活 Agent、resume 之后、提交任务之前。注册表的 `default` 是可选的，这样一个组合可以只为这个 projection 而挂载注册表；未指定 preset 的调用方在解析或挂载 preset 的位置失败。

### 折叠函数

- `foldConsumedWorkForEvent(state, event)` 接受此前事件的折叠状态和下一个事件，返回包含该事件的折叠状态。`undefined` 表示第一个事件之前的状态，所以该包不导出初始值。`ConsumedWorkFoldState` 在 `ConsumedWork` 之上增加折叠自身的字段：当前打开的轮次和两个轮次编号集合。这两个集合被原地更新并带入返回的状态，所以调用方对每个状态只推进一次。
- `foldConsumedWork(events)` 的签名和返回字段不变。它用 `foldConsumedWorkForEvent` 在数组上推进同一个状态，所以两个函数应用同一条规则。
- `AssistantOutputFold` 在出现非空消息之后丢弃其流式文本兜底。此后 `collect()` 不会再读取该兜底。SDK 和 ACP 后端使用同一个类。

## 考虑过的替代方案

**把结果保存在 Session projection 中。** projection 为重启后的恢复而持久化状态。没有消费方在产生结果的进程退出之后读取运行结果，而新的 activation 从空的折叠状态开始。该状态还要保存一整条消息，大小不固定。

**记录 activation 开始或结算事件，并读取标记之间的区间。** 这些标记能让之后的进程找到该区间，但没有消费方需要这一点。结算仍然要读取该区间，只是从内存改为从存储读取。

**通过显式的异步存储读取来读后缀。** 结算需要的是两个推导值，而不是这些记录本身。这种读取会让每次结算都增加与区间长度成正比的 I/O，而且 `agent/disposed` 路径是在写句柄关闭之后同步获取结果的。

**要求每个子会话通过工具交回结果。** 这回答的是另一个问题：结果是什么，而不是结果如何计算。子会话没有调用该工具就结束时，仍然需要"最后一条消息"规则，所以折叠仍然存在。仅子会话可见的工具和提示词段还会破坏 fork 子会话继承前缀的 KV Cache 复用，而 [fork 决策](2026-08-10-fork-children-stay-one-shot.zh.md)避免了这一点。

**只根据 Session header 决定是否沿用。** header 记录的是 Session 创建时的 preset。空白 Session 可以改选另一个 preset，这会记录为 `agent-preset/selected`，而 header 不变。一个创建时没有 preset、之后在某个 preset 下被复用的 Session，会被沿用并在 headless 的工具和提示词下继续运行。

**每个事件都复制两个轮次编号集合。** 完全不可变的状态要在每个驻留子会话的每个事件上复制这两个集合，而 `claimed` 随轮次数增长。唯一的消费方私有地持有自己的状态，并且只使用返回值，所以以后改为不可变实现时调用方无需改动。

**用逐事件函数取代 `foldConsumedWork(events)`。** 数组形式是 `@deepseek-ai/dsh-agent` 的已发布导出。保留它使其调用方和现有 spec 不变，代价是该插件入口多一个值导出。

**用描述当前打开轮次的标量取代 `foldConsumedWork` 的两个轮次编号集合。** 状态变为固定大小，但 `step/start` 和 `turn/end` 以各自携带的轮次编号为键，而不是以当前打开的轮次为键，所以等价性需要单独论证。轮次关闭时，两个集合都移除该轮次编号。

## 影响

- `activation.ts` 和 headless runner 不包含同步历史读取。
- 每个 headless Session 的 projection 检查点带有一行 `agentPreset`，随 DeepSeek 请求发送的插件包列表包含注册表这个包。
- `--session-id` 要求 `agentPresets` 服务。沿用在存在缓存的 projection 行时读取该行，所以损坏的缓存行可能拒绝一个按其日志本可沿用的 Session。
- 畸形的 `agent-preset/selected` 记录不会被报告为畸形。已持久化的 Session 若该值缺失或不是字符串，会在 observation 生成 projection 时失败；存活的 Session 带有这样的值，或任何 Session 带有空字符串，会以该值的文本作为 preset 名称而被拒绝；`null` 值被读作没有 preset，该 Session 会被沿用。写入方只记录非空字符串。
- 挂载注册表之后，选择了 agent preset 的 `tool-subagent` 行在没有声明任何 preset 的组合里也会激活；未知的 preset 在启动子会话时才被报告。
- 折叠步骤在 `Session.append` 内对每个驻留子会话的每个事件运行，而后缀读取每次结算只运行一次。owner scope 上的监听器也会被进程内其他每个会话事件调用，做一次 map 查找后返回。
- 进程树被释放之后，headless 的折叠在 Agent 的 scope 被释放时结束，而 `run` 在此之后才读取结果。这期间追加的 `turn/start`、`assistant/message` 或 `turn/end` 不会被折叠。只有 agent loop 的驱动器追加这些类型，而它在自己的 scope 被释放之前已经空闲。
- 即使 `drain()` 拒绝，管理器也会释放 activation-owner scope 并移除其监听器。
- 结果必须在 `session/event` 派发之外读取。批量追加先把所有成员写入日志，再派发第一个成员，所以在监听器内读取会看到落后于日志的折叠。
- 本决策不负责"运行的输出是其最后一条非空 assistant 消息"这条规则，也不负责补发因父会话离线而丢失的结算通知。

## 测试

- `consumed-work.spec.ts` 通过 `foldConsumedWork(events)` 断言每个场景，该函数对每个事件运行 `foldConsumedWorkForEvent`；它还直接从 `undefined` 起推进一个状态。
- `continuation.spec.ts` 在三种拆除方式下断言 activation 结果等于对子会话日志后缀的批量折叠：其他所有者释放子会话、管理器卸载，以及子 scope 的 disposer 在子 scope 的监听器被移除之后追加一条消息。监听器注册在管理器 context 或子 scope 上时，后两种会失败。
- `continuation.spec.ts` 把管理器挂载在其子会话不在其中的 scope 下，并断言子会话的输出；没有全局监听器时它会失败。它还追加一个输出折叠无法读取的事件，并断言结果以该折叠的错误被拒绝。
- `local-result.spec.ts` 覆盖两个折叠的错误被重新抛出的顺序，以及实时失败时跳过停止原因折叠的情况。
- `terminal-failures.spec.ts` 在流式输出的轮次进行中释放 runner 的插件，并断言 `final` 事件带有部分文本和 `disposed` 中止原因。折叠注册在插件 context 上时它会失败。
- `headless.spec.ts` 通过 `run` 覆盖区间规则、区间的起始 offset、退出码和实时失败的优先级，以及折叠错误被报告为本次运行的失败。
