# Agent Note: 计时用户提问的两次结算

Status: proposed

[English](2026-09-19-timed-user-question-two-settlements.md) | 中文

## Problem

即使还有不依赖回答的工作可做，问题仍可能阻塞 agent（智能体）。等待后放行工具调用不能丢弃问题：用户可能在 agent 继续执行后，或重新打开 Session 后才回答。pending 结果既不是跳过回答，也不是开展需要批准的工作的授权。

前台工具结果与最终回答的生命周期不同。`user-questions/request` waterfall（瀑布式事件）只结算一次；返回 pending 后仍保留它，会产生一条活过调用方的第二回答路径。倒计时、聚焦和编辑的归属也不同于持久问题状态。

## Proposal

前台回答继续使用现有 Remote Event waterfall。超时结束该请求并返回 pending；迟到回答通过业务 RPC steer 一条持久用户消息。接手 stream 只控制前台等待，既不传递回答，也不替代 Remote Event。

### 模式与范围

- 默认 `mode: legacy` 保留阻塞式 schema 和 `ask()` 路径。显式 `mode: timed` 增加 `timeout`，省略时使用配置默认值 120 秒。
- 正整数超时选择 `askTimed()`；`-1` 选择阻塞式 `ask()`。timed schema 发出的阻塞调用仍参与计时问题投影和答案查看，并不等同于 legacy 调用。
- 计划评审保留 `ask()`、`plan-review` 意图及 `BAD_INTENT` 校验。本决策不把计划评审迁移到其他包。
- 提供 Agent 时，人机交互要求它是运行时中确切的存活根实例。陈旧实例以 `CALLER_NOT_LIVE` 失败；被其他 agent 拥有的子实例以 `DELEGATED_CALLER` 失败。持久 Session 的血缘关系不妨碍恢复后的运行时根实例提问。

### 职责归属

| 归属方 | 职责 |
|---|---|
| `tool-ask-user` | 模型 schema、超时校验、服务选择和 pending 结果文本。 |
| `UserQuestionService` | 前台等待与 Client 接手、无人接手时的 deadline、迟到回答校验与 steering（中途引导），以及持久问题投影。 |
| Gateway 与 Remote 运行时 | 现有请求投递、结算、取消及 Remote stream 传输；不包含问题专属计时器或按事件名分支。 |
| `ui-user-questions` | 每个 Session 和调用的一张卡片、回答通道选择、本地倒计时与草稿，以及回复 Definition 和渲染器。 |
| `ui-chat` | 基于消息 id 的呈现聚合，以及普通过程／轮次折叠。 |
| 问题专用工具行 | pending／已回答呈现与面板操作，在 `QuestionToolRow` 中组合，不向通用 `ToolRow` 添加 `rowAction`。 |

[问题服务](../../../../packages/interaction/user-questions/README.zh.md)、[工具](../../../../packages/interaction/tool-ask-user/README.zh.md)和[问题 UI](../../../../packages/client/ui-user-questions/README.zh.md)分别拥有各包的约定。

### 前台等待与接手生命周期

`TimedQuestionWait` 拥有专属取消 signal、原始 Host deadline 和 Client 接手记录。Host 只在没有回答 UI 接手时运行计时器。投递到传输队列不算接手。最后一个接手方离开后恢复原 deadline，已经过期则立即到期。

计时请求携带 `wait: { callId, timed: true }`。Client 在挂接回答通道前打开业务 Remote stream `attachWait`，接收一帧由 Host 计算的 `remainingMs`，并在接手期间保持 stream 打开。聚焦、编辑和心跳不经过该 stream。

Client 将接手保留到 waterfall 结果交付给 Host。本地返回回答不等于交付：此时释放接手会让已经到期的 Host 计时器抢在回答之前结算。Host 在前台请求结算时关闭接手。显式委托在 `next()` 前释放接手；插件拆卸会委托请求并取消自己的 stream。

Client 倒计时到期以 `ASK_TIMED_OUT` 拒绝 waterfall。无人接手时，Host 到期只以同一业务错误中止等待专属 signal。`askTimed()` 只把该错误映射为 pending，把父级取消映射为 `ASK_ABORTED`，其余失败继续传播。`NO_PROVIDER` 等待同一个有界等待生命周期，而不是永不结算的 Promise。前台完成时释放计时器、接手记录及等待注册项。

### 持久状态与迟到回答

`userQuestions` 投影从现有 Session 事件重建问题状态。它通过 `request/header` 记录的 `timeout` 参数识别 timed schema，不跟踪 legacy 调用。有效的 `tool/call` 打开问题。其 `tool/result` 在 pending 或 `TOOL_OUTCOME_UNKNOWN` 时将问题标为已继续，在有效回答批次时结算并保存答案，其他结果或失败则移除问题。

已继续的问题接受 `answer(agent, callId, answer)`。未知或非已继续调用返回 `false`；回答批次没有恰好包含每个问题一次时抛出 `BAD_ANSWER`。接受的回答通过 `agent.steer(createUserMessage(...))` 送入 agent，来源为 `{ kind: 'user-question-reply', callId, outcome: 'answered' }`，JSON 文本包含 `answer_to_pending_question`、调用 id、原问题及答案。Remote 根据 Session id 解析 Agent 时按需恢复根实例；恢复操作不属于 `answer()` 方法体。

inbox 消息就是持久回复。`agent/inbox/spliced` 在消息入队时结算问题；随后接纳的 `user/message` 对该结算是幂等的。已结算答案批次保留在投影中，让原工具行即使自身结果仍是 pending，也能显示迟到回答。无法使用的已记录回复文本以空答案批次结算。

无需新增 Session 事件类型或等待状态日志。消息来源扩展需要仓库的持久化类型变更确认。`dismissed` 为历史记录保留可读性，但没有生产者：隐藏面板不会伪造回复。

### 卡片状态与投递竞争

`QuestionCards` 按 Session 和 `callId`，让实时请求与已继续投影共享一个 `PendingQuestion`。没有调用 id 的阻塞请求拥有独立的逐请求卡片。开放卡片通过 waterfall 提交；缺少该通道时禁用提交。已继续卡片使用迟到回答 RPC。

waterfall 提交没有送达确认。Gateway 可能丢弃输掉结算竞争的结果，因此卡片保留草稿并保持忙碌，等待投影同步。若提交期间问题变为已继续，控件带重提提示重新可用，用户可以通过 RPC 提交保留的草稿。这不是自动重试，也不保证每次本地提交都能到达模型。

按工具调用标识的卡片在调用不属于活动投影且没有 waterfall 时移除。移除会关闭卡片并清理草稿。本地提交和传输取消帧都不能单独决定问题已经回答。无调用标识的阻塞卡片随 waterfall 结束；关闭这种阻塞面板以 `ASK_CANCELLED` 拒绝请求。

### 本地倒计时与面板操作

Client 计算 `Date.now() + remainingMs`。手动聚焦未编辑的回答区会暂停倒计时，失焦后从保留的剩余时间继续。接手握手前的聚焦在 deadline 到达时仍生效；握手前失焦不会制造计时器。首次编辑或「慢慢回答」冻结倒计时，该状态与浏览器本地草稿一起保存。

只有回答通道就绪、没有活动倒计时且卡片未锁定时才自动聚焦。隐藏计时调用的面板会保留接手和倒计时，工具行可以重新打开面板。已结算调用依据记录的问题与答案打开只读面板，不产生另一条回答通道。

### 回复节点与分组

问题 UI 通过 `source.kind` 识别迟到回复，再解析已记录的 JSON 来呈现问答。普通用户消息粘贴相同 JSON 不会被识别为回复。无法读取的已记录载荷保留原始文本呈现。

普通消息 Definition 和问答回复 Definition 都匹配追加的消息，在 Node Store 中保留消息 id 相同的独立投影。存在同 id 的 `question-reply` 时，Chat 业务分组省略 `turn-trigger` 呈现。重复触发节点既不渲染，也不切开分组，回复只显示一次。相同聚合也适用于无轮次归属的历史输入。

回复参与普通过程分组和整轮折叠，不保证独立可见：阅读时可能需要展开所属轮次与过程分组。轮次折叠控件始终在所控制的分组之前，包括由回复开启轮次的情况。

本决策不添加 process-role 字段、独立布局标记、用户消息结构变更或目标内 fallback 派发。独立 kind 规则保留在 Chat 现有分组逻辑中。由节点 data 声明分组与重叠语义的机制是留待拆分的基础设施，不属于问题功能。

## Alternatives considered

**无条件 Host deadline 或 Gateway 拥有问题计时器。** 无条件 deadline 会覆盖本地编辑和「慢慢回答」。把例外放入 pending Remote Events，或在 Remote 派发中按问题事件分支，会让通用传输拥有业务策略。接手机制将策略留在问题服务中。

**返回 pending 后继续保留 waterfall。** 请求活过工具调用方，迟到的 waterfall 回答与 RPC 竞争。结束前台请求让每次结算各有一条回答路径。

**立即委托所有计时请求。** 向故意留空的回答方集合派发请求，浪费现有阻塞回答路径，还要求特殊处理 `NO_PROVIDER`。委托表示回答方不可用，不代表计时模式本身。

**持久化整值等待／聚焦／编辑流，或使用 Host 聚焦租约。** 持久问题状态可从工具与 inbox 事件推导。聚焦和编辑属于本地 UI 状态；记录它们或同步聚焦租约会增加 Host 状态，却不能让多个 Client 共享同一编辑会话。

**在通用 `MessageItem` 内重新分类 JSON、借用 relay form，或使用默认 context 行。** 解析文本来识别业务消息混淆了来源与内容；relay form 表示其他 agent 的消息，通用 context 行则会暴露 JSON。专用来源、Definition 和渲染器拥有问题呈现。

**通过通用节点元数据让回复独立布局。** 这会把问题功能扩大为对话基础设施变更。普通折叠与 Chat 内聚合足以满足本决策；由节点 data 独立声明分组语义仍是单独的设计任务。

**面板关闭时写仅入日志的关闭事件，或伪造放弃消息。** 仅入日志会让模型看不到用户决定，还增加另一套持久机制。伪造回复则把隐藏面板当成回答。因此关闭面板仍让计时问题保持可回答。

**在 inbox 消息之外增加专用迟到回复 Session 事件。** inbox 插入与接纳的用户消息已经记录回复。第三个事件重复同一事实，并增加另一种持久化类型。

## Acceptance criteria

- 服务测试覆盖有人与无人接手、最后接手方断开、取消、超时错误映射、仅接受已继续问题的回答，以及答案 id 的精确校验。
- 投影测试区分 legacy 与 timed schema，并覆盖 pending、已回答、其他失败、恢复修复及 inbox／消息重复结算。
- Client 测试覆盖接手保留到 Host 接受结果、握手前聚焦、无限期等待、草稿保留、RPC 重提及面板隐藏／重开。
- 分组与浏览器回放覆盖保留两个投影但只渲染一次回复、普通折叠位置、折叠控件顺序，以及原工具行的迟到答案只读面板。
- legacy 问答往返、取消、计划评审意图及 Session 重新挂载保留既有行为。真实多 Client 投递竞争与真实 Host 重启仍是独立生命周期和投影测试之外的集成覆盖缺口。

## Risks

- 「慢慢回答」只影响一个 Client。其他 Client 可以回答或让共享 waterfall 到期，本地聚焦不构成全局暂停。
- 接手 stream 的终止性失败可能让前台问题失败，而不是产生 pending。不为该失败提供无人接手等待的 fallback。
- Host 与 Client 时钟不必对齐，但 Client 系统时钟变化可能移动到期时间，传输延迟可能推迟本地倒计时的开始。
- 重复投影仍保留在存储中。聚合在结构性分组重建时增加线性扫描；普通纯文本 stream 更新保留增量路径。这是算法复杂度界限，不是实测延迟结论。
- 无人回答的已继续问题可以在重新打开 Session 后继续存在。关闭面板不写记录，可见性遵循普通折叠，而不是保证回复始终可见。
