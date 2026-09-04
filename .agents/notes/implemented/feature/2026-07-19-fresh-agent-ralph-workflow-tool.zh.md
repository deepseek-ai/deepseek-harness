# Agent Note: 全新 agent Ralph 工作流工具

Status: implemented

[English](2026-07-19-fresh-agent-ralph-workflow-tool.md) | 中文

## 问题

同会话目标会保留对话，让一个 agent（智能体）持续完成持久目标；通用工作流工具则让模型编写扇出编排脚本。两者都不是 Ralph 模式：把同一目标反复交给全新的工作者，以共享工作区作为长期记忆，并且在各 Round 之间只传递一份小型显式交接，直到工作完成或触及限制。

如果把 Ralph 行为加入 `dsh-agent-loop`、目标驱动器或面向模型的公开工作流语言，就会让一项策略与无关的执行机制耦合。让每个子 agent 继承父对话也会破坏上下文重置，并让重放依赖不断增长的隐式前缀。此功能需要一项由现有插件原语组合而成的固定、可评审策略，同时保证取消后完全停稳、有界跨 Round 数据、宽裕且可配置的上限，并且不引入新的面向人类目标状态。

## 决策

在 `packages/workflow/` 下新增独立的消费方包 `@deepseek-ai/dsh-tool-ralph`。它注册 `ralph({ objective, maxRounds? })`，拥有固定工作流脚本，并且只依赖 `ctx.tools`、`ctx.systemPrompt`、`ctx.workflowEngine` 和 `ctx.subagents`。Ralph 运行不是会话目标，不会创建目标状态，也不要求在具体 agent loop 中增加分支。

该工具仅以前台方式运行。调用 agent 作为每个子 agent 的父级以提供 cwd 和谱系，父工具调用等待整次运行结束，父步骤的中止信号会取消工作流。每条路径都会等待 `run.dispose()`，因此调用返回前，取消会经过工作线程引擎的有界收敛并使子 agent 完全停稳。

### 每次运行的工作流提供方路由

`WorkflowStartRequest` 新增可选的 `subagentProvider`。工作线程引擎先解析这个显式的每次运行值，再回退到引擎配置的提供方；在发布运行前，它要求所选规范化路由已注册，并把结果用于每次 `agent()` 调用。脚本无法观察或替换此路由。普通 `workflow` 工具不设置该字段，也不暴露新的模型参数，因此通用工作流行为和提供方策略保持不变。

Ralph 插件的 `subagentProvider` 默认为 `spawn`。每次调用前，它要求具名提供方已存在、支持结构化输出且报告 `inheritsParentContext: false`；类似 fork 或能力不足的提供方会在工作流启动前明确报错。提供方查找保留在调用期，因为效果作用域内的提供方注册可能随 HMR（热模块替换）改变。

### 每次运行的工作流子 agent 上限

`WorkflowStartRequest` 还新增可选的 `maxTotalAgents`。工作线程引擎要求它是正安全整数且不高于已配置的部署上限，并在发布运行前把解析值装入该运行的工作线程限制。Ralph 把解析后的 `maxRounds` 作为此上限，因此固定循环的 Round 预算不会与通用失控子 agent 后备限制冲突。普通工作流工具不设置该字段并保留引擎默认值。

### Ralph Round 与交接

层级为 Ralph 运行 → Ralph Round → 全新子 agent 轮次 → 步骤。每个 Ralph Round 恰好通过所选提供方创建一个子 agent。spawn 给该子 agent 一个没有种子的独立会话，同时保留父级 cwd，因此共享工作树是持久权威，父对话和先前子 agent 历史都不会进入请求。

固定提示只传递不可变目标、当前 Round 与上限、以工作区为权威的指令，以及上一份结构化报告。`RalphRoundReport` 包含 `status: continue | complete | blocked`、`summary`、`evidence`、`nextSteps` 和 `blocker`。字符串必须规范化；`continue` 要求存在下一步且没有阻塞项，`complete` 要求存在证据且没有下一步或阻塞项，`blocked` 要求具体阻塞项。报告成为下一次交接前，脚本会验证语义与序列化大小；消费方还会跨 workflow seam 再次验证实体化的终止值。

`maxRounds` 默认为 `256`，同时也是调用覆盖值的部署上限。`maxHandoffChars` 和 `maxResultChars` 均默认为 `16384`。三者都是正安全整数配置值。过大的交接会失败，而不会被静默截断；`maxResultChars` 单独限制面向父级的完整成功文本，包括外层文本和截断标记，并且不会改变跨 Round 状态。最后一个允许的 Round 报告 `continue` 后，固定脚本返回 `budget-limited`；`complete` 和 `blocked` 会立即返回最终报告与已启动的 Round 数。

工作流语言会把正常结束但未成功的子 agent 映射为 `null`。固定脚本会在报告验证前检测该值，并返回 `round-failed`，其中包含失败的 Round，以及存在时的上一份成功交接；工具会把它转成错误，而不会误判为畸形报告或预算耗尽。Ralph 不添加重试策略。致命的提供方启动、传输、工作线程和工作流错误仍是通用工作流失败，因为这些路径上的 workflow seam 不携带可恢复的子报告。

### 模型与 UI

模型只能提供 `objective` 和可选的 `maxRounds`；提供方选择、报告 schema、交接上限和脚本都由部署方控制。固定提示区段说明，只有直接交互的人类明确要求 Ralph 或全新 agent 迭代时才使用 `ralph`，并将其与同会话目标、有界委派和通用扇出工作流区分开。这是指导，而不是新的目标 UX 状态机。

面向人类的展示使用通用 `ralph` 卡片，并把目标作为原始输入；ACP（Agent Client Protocol）只承载已提交的助手文本。成功完成与阻塞的外层文本会说明结果由工作者报告，而不会把它呈现为独立认证。父级 transcript（文本记录）只保留原始工具调用，以及一份有界成功终止报告或一个错误，不包含中间子 agent 消息。发布的无头、TUI 与 ACP 组合会在现有工作流引擎旁加载该插件；JSON-RPC 保持不变，因为其默认组合不暴露工作流。

## 测试

单元测试覆盖配置与调用上限解析、提供方能力拒绝、固定启动请求路由与子 agent 上限、全部成功终止结果、普通子 agent 失败外层值、畸形及过大边界值、成功结果精确截断、中止时序、dispose（资源释放）、渲染意图、提示生命周期和命名空间插件形状，并达到逐文件 100% 覆盖率。工作流引擎测试证明提供方路由会同步验证、每次运行的子 agent 上限可低于部署上限，并且提供方覆盖会选择每个子 agent 且不改变配置默认值，其中包括普通 Node 下构建后的 `lib/worker.cjs`。

一项无 key 真实栈 integration 通过实际 worker-thread engine、spawn provider、structured-output runtime 与 agent loop 驱动固定 script。它证明 child agent identity 不同、`isSeeded: false` 且 cut 为零、继承 cwd、两个 child request 都不含 parent-history marker、上一份 report 只精确出现在下一 Round handoff 中、只产生一个 phase event、terminal completion，以及两个 child agent 都已 dispose。同一真实栈还覆盖 blocker 与 Round-limit outcome、未规范化及语义无效 report、过大 handoff、保留上一份有效 handoff 的普通 child failure，以及取消后 child 完全停稳。无 key [`ralph-loop` headless snapshot](../../../../snapshots/session/ralph-loop/)调用 `ralph`、固定 parent stream transcript，并检查持久 log 中存在两个不同且 unseeded 的 child Session，且 Round 1 handoff 只出现在 Round 2。Tool test 固定通用 call/result presentation，request-header snapshot 固定已发布 schema 与 prompt-guidance transcript。

## 考虑过的替代方案

- **把 Ralph 放进同会话目标驱动器** — 拒绝，因为 Goal Round 有意保留同一段对话，而 Ralph 的定义性属性是每个 Round 使用全新上下文；合并两者会让目标生命周期与子 agent 编排无法分离。
- **在通用工作流工具上暴露 `fresh` 或循环标志** — 拒绝，因为模型编写的脚本 API 应保持通用且与提供方无关；Ralph 的固定报告协议和停止策略值得拥有一个可评审消费方。
- **为了方便重放而使用 `subagent_fork`** — 拒绝，因为继承的已完成轮次是隐式、不断增长的交接状态，并违反全新上下文约定。工作区加一份结构化报告即可重放，无需插入人为取消记录。
- **让工具直接调用 subagent seam** — 拒绝，因为现有工作流引擎已经拥有前台编排、结构化子 agent、取消传播、工作线程终止、事件和负责 dispose 并等待完全停稳。复用它可以展示插件组合，而不是构建第二个循环运行时。
- **静默截断大型报告** — 拒绝，因为截断可能删除状态证据或下一步，却仍看似权威交接。生产方必须在配置边界内发出有效报告。

## 后果

- 全新 agent 迭代成为一项一等模型工具，并完全以现有 seam 之上的可移除插件实现。
- Goal Round 与 Ralph Round 保持不同概念：前者是一次同会话续行轮次，后者是前台工作流中的一个全新子 agent。
- 工作区成为权威跨 Round 记忆，因此工作者必须检查和验证工作区，而不能信任叙事性交接。
- 宽裕的 Round 上限允许大量自治工作，而部署配置仍会限制子 agent 数量，并且每次交接始终受大小约束。
- 提供方路由与可降低的每次运行子 agent 上限成为显式的工作流启动关注点，但不扩展脚本或普通工作流工具集。

## 已知限制与暂缓事项

- 完成与阻塞状态由工作者自行声明。独立评估器、评估器驱动的反馈 Round、完成证书或对抗式 verifier 被有意推迟。
- 运行位于前台且只存在于进程内。后台收集、持久化/恢复、调度和重启恢复均不存在。
- Round 数是唯一聚合预算。token、货币、耗时和提供方用量预算仍属于未来的独立策略。
- 每个 Round 创建一个子 agent。Round 内扇出、评估器/工作者角色分离、动态提供方或模型选择，以及跨运行日志均被推迟。
- 普通子 agent 失败会结束运行且不重试，同时保留失败 Round 与上一份成功交接。致命工作流基础设施错误可能在固定脚本返回该状态前结束；增加重试或更丰富的失败传输需要独立的策略与边界设计。
- 提示指导模型不要递归调用 Ralph；结构化的子 agent 工具限制需要另行设计工作流子策略 API。
