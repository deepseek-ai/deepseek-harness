# Agent Note: 调用后压缩压力与上下文溢出恢复

Status: implemented
Archived: 2026-09-30

[English](2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) | 中文

## 问题

`agent/pre-step` 运行在最终请求路由之前，也早于 assistant 输出、工具结果、缓冲上下文与 steering（中途引导）的产生。即使它接收已装配提示词与会话前缀，压力视图仍是临时的，因为 `agent/request` 还可以改变路由或调用配置，工具 schema 也没有与这些输入一同冻结。增加字段无法让调用前状态描述已完成调用，还会把通用扩展点与压缩（compaction）耦合。

成功调用也不是唯一的压力信号。提供方可能在返回 usage 之前就因上下文窗口超限拒绝请求，一些成功调用也不提供 usage。因此，系统需要可回放的调用后压力，以及一条狭窄的失败恢复路径；当压缩无法证明取得有效进展时，必须保留原始提供方错误。

## 决策

### 成功压力在下一个 pre-step 边界运行

`agent/pre-step` 接收独占的已领取消息批次与 `{ turn, step, signal }`，并返回最终 reject/enter 决策。它不携带压缩专用的提示词或前缀字段。

Compact-basic 会在每个拟议请求之前包装 `agent/pre-step`。在续步边界，前一条 assistant 输出、所有已分发或合成的工具结果、工具后上下文与 steering 都已经持久化，因此压力策略能看到完整的成功调用状态，同时不会拆开 assistant 工具调用与其结果。初始边界上的无 header 会话尚无已完成路由请求，因此不执行压力工作。Compact-basic 会在内部处理操作性失败、发出警告并继续委托，不会 reject 拟议步骤。

`dsh-compaction-basic` 从持久请求头读取精确的最新实际路由模型，只用它确认已经存在已完成的路由，随后让单例 `ctx.tokenMeter` 计量规范日志信封与当前表层。自动压力不会回退到 `AgentOptions.model`。没有请求头的会话尚无已完成路由请求可供判断，因此不执行工作；任意持久记录的非空模型名都使用同一个估算器。操作性的计量或摘要失败会发出警告，并从最新持久表层继续：任何替换发生前使用完整历史；若剪枝已经落盘，则使用已剪枝表层。

### 请求恢复只覆盖最终模型边界

`agent/request-error` 表示来自最终适配器边界的终止失败。适配器选择、分发、iterator 构造与迭代抛出会在 agent loop（智能体循环）消费前成为终止 `error` 或 `aborted` finish；适配器直接发出的终止 finish 进入同一路径。提示词装配、请求 middleware、请求日志、结果处理、工具、step 监听器与清理仍属于普通失败。[LLM（大语言模型）流的终止失败](2026-07-29-terminal-llm-stream-failures.zh.md)规定这一规范化边界。

恢复运行前，失败 step 已经关闭。负责处理的监听器修复持久状态、返回 `{ kind: 'retry' }`，并停止 waterfall（瀑布式事件）委托。循环随后关闭失败 turn，并从持久日志开启一个重试 turn，中间不发布空闲通知。重试策略与尝试计数由插件自己拥有；compaction-basic 在链路到达终态 `agent/settled` 时清除对应 agent 的溢出计数。两个 DeepSeek 适配器都把识别出的提供方上下文限制错误规范化为 `CONTEXT_WINDOW_EXCEEDED`。[重试动作决策](../simplification/2026-07-27-request-error-retry-action.zh.md)规定这一返回边界。

如果取消发生在 assistant 工具调用已经持久化之后、所有调用完成分发之前，循环会为每个尚未分发的调用记录一对合成的 `tool/call` 与 aborted `tool/result`，随后进入正常中止路径。因此，表层不会仅因取消赢得竞态而留下孤立的持久工具调用。

### CompactionEngine 暴露意图，而不拥有 token 核算

`CompactionEngine.compactIfNeeded(agent, trigger, signal)` 接收 `trigger: 'pressure' | 'context-overflow'`。接口不增加估算方法或 token 类型；`ctx.tokenMeter` 继续作为可复用的核算所有者。

对于 `pressure`，compaction-basic 先解析持久提供方/模型目标对应适配器所维护的容量与精确目标策略，再把得到的阈值与保留尾部预算应用到一次统一的 `ctx.tokenMeter.measure()` 结果。未达到压力阈值时直接返回，不执行剪枝。压力达到条件后，可选的 `ctx.toolResultPruner` 会改写当前表层中过大的工具结果，compaction-basic 再通过同一个 meter 重新计量；若压力已降至安全水平则跳过模型调用，否则从已剪枝表层选择范围并生成摘要。范围定价、引用的源事件计量、被遮蔽 token 数与非缩小摘要拒绝也由同一个单例 meter 完成。通用默认值保持为阈值比例 `0.8`、保留历史比例 `0.16`、摘要提供方/模型 `''`、`maxTokens: 8192`、`compactionRetries: 1` 与 `auto: true`；可选 `modelPolicies` 项可以按精确提供方/模型组合覆盖这些值。

对于规范化溢出，compaction-basic 不要求容量元数据，并绕过标量压力与普通保留 token 预算。它先执行剪枝，再在保留最新不可分割单元的同时选择最大的工具配对平衡头部范围；存在范围时，才在同一 signal 下尝试一次缩小摘要压缩。自动监听器先对 `session.surface.replaceGeneration` 建立快照，剪枝或摘要让 generation 增加时就返回 `{ kind: 'retry' }`。即使剪枝先落盘而后续摘要工作抛错，这条规则仍然成立；取消依然优先。后端若只返回结果但没有替换表层，不能授权重试；只有剪枝取得进展时，即使没有 `CompactionResult` 也可以授权重试。

`maxOverflowRetries` 可选且默认为 `1`；`0` 只禁用溢出恢复，不会禁用压力检查。`auto: false` 不注册任何自动监听器。非规范化错误、尝试耗尽、已经中止的 signal、缺失路由模型、没有安全范围、generation 未变化，以及在任何替换之前恢复抛错，都会委托给下一个监听器。若没有后续恢复，循环报告原始提供方错误对象与代码。generation 增加后的恢复抛错会基于持久进展授权重试；即使恢复工作并发完成，取消或 dispose（资源释放）仍具有最终优先级。

默认摘要器依次解析显式配置、最近记录的路由与 agent options。因为直接 `llm/stream` 中间件可以重新路由该辅助调用，`compaction/summary.{provider, model}` 记录分发后观察到的可变 `GenerateOptions` 最终目标，而不是 waterfall 之前的候选值。

## 测试

单元测试覆盖最终适配器规范化边界、已关闭 turn 的重试编号与重置、取消与 dispose、step 边界顺序、已路由信封压力、压力门控剪枝、剪枝独立解除压力、从已剪枝输入生成摘要、平衡溢出缩减、后续失败前已落盘的剪枝进展、generation 证明、上限、委托与辅助调用路由。真实循环测试覆盖抛出式和带内溢出在经剪枝或摘要压缩后重建重试请求的过程。

## 考虑过的替代方案

- **向 pre-step 增加压缩专用字段**——不予采纳，因为规范持久会话与 token meter 已拥有计量输入；通用生命周期不需要携带第二份信封。
- **重试相同编号的 step**——不予采纳，因为恢复会在失败边界之后追加持久事件。新 step 保持平衡嵌套与可重建性。
- **只要 `compactIfNeeded` 返回结果就重试**——不予采纳，因为自定义后端可能报告成功却没有改变模型可见状态。`replaceGeneration` 才是权威证明。
- **让 compaction-basic 解析提供方措辞**——不予采纳，因为分类属于适配器，而且必须同时覆盖抛出式与带内交付。
- **没有持久路由时回退到 `AgentOptions.model`**——不予采纳，因为自动策略必须描述已完成且已记录的请求。没有请求头的压力检查与恢复会原样委托。

## 后果

下一个 pre-step 的压力检查描述前一个已完成的路由请求，包括持久工具结果与新领取输入。可选的无模型剪枝会在选择摘要前移除可预测的工具输出体积，也能独立产生足以重试的进展。当成功 usage 锚点不存在时，规范化溢出提供兜底路径。恢复有明确上限、以取消为准，并保持单调：只有模型可见的表层 generation 变化后才重试。

代价是在共享 pre-step waterfall 中执行压力工作，并需要适配器持续维护溢出分类。提供方措辞与启发式字符密度仍是维护风险。表层压缩依然无法修复仅信封本身就超出窗口的情况，也不能拆分不可分割的非工具节点，或修复不可剪枝的剩余部分仍然过大的工具单元。若可移除的文本工具结果是主要体积，可选剪枝器仍可修复原本不可分割的工具配对。

[已领取 pre-step 生命周期](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)取代了本记录原先的 post-step 触发方式。服务拆分、独立 token meter、平衡范围约定、日志中记录的锁、摘要替换与唯一 `summarize()` 子类 hook 均保持不变。
