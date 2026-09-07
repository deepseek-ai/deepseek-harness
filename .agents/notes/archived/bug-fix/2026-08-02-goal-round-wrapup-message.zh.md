# Agent Note: Goal Round 收尾消息

Status: implemented
Archived: 2026-09-04

[English](2026-08-02-goal-round-wrapup-message.md) | 中文

## 问题

自主 Goal Round 报告 `update_goal` `complete` 或 `blocked` 时，物理轮次在工具结果处直接终结，模型在调用之后再无发言机会。会话终止在一张裸的 `update_goal` 卡片上，内测同学的观感是 agent 话说到一半戛然而止：模型调用前的文本通常预告了一份汇报（“目标达成，标记完成：”）却永远没有下文，因为标准 tool-use 预期是工具结果之后还有一条 assistant 消息，而 Goal Round 提示词与工具描述都没有说明这次调用是终点。硬停止来自 [goal 工具决策](../feature/2026-07-19-model-facing-goal-tools.zh.md)，本 note 取代其中的轮次停止条款。

## 决策

Goal Round 的 `complete` 或 `blocked` 成功不再调用 `concludeTurn()`。工具改为在自己的结果上附带一条收尾上下文：以 `{ kind: 'plugin', plugin: 'tool-goal' }` 为 source 的 user 消息，携带 `<goal_complete>`/`<goal_blocked>` 指令，要求模型向用户写出有依据的收尾消息且不再调用工具。之后轮次经由 agent loop 常规的无工具调用停止路径结束，因此不存在新的 loop 原语，steering 语义不受影响。人类直接变更保持原样、不注入指令。代价是每个 goal 生命周期一次额外模型请求，而非每轮一次。

指令措辞通过在 `deepseek-v4-pro` 上用重构的 Goal Round 转录做 A/B 采样选定：结构化指令（结果、验证、产物、后续）在完整度上稳定优于极简“总结一下”；补充“以会话内证据为准”的 grounding 条款让无依据细节从断言事实退为带保留的建议；而无指令对照组的收尾方差很大，包括言之凿凿的文件级细节编造。

为让 keyless 证明可脚本化，快照设施补了一项能力：`dsh-llm-replay` 会针对实时请求解析脚本条目中的 `{{fromRequest:<regex>}}` 占位符，因为静态伴随文件不可能预知模型必须回填进 `update_goal` 的随机生成 goal id。

## 验证

`tool-goal` 包测试钉住两个终态 action 注入的上下文（source、标签、objective、禁止再调工具条款）与不存在的 `concludesTurn`，以及人类直接 pause 与 complete 的不注入路径，文件覆盖率 100%。`llm-replay` 单元测试钉住占位符约定：最后一次匹配取胜的捕获、无捕获组时整体匹配回退，以及未匹配、非法、未闭合模式的明确报错。新增 keyless ACP 快照 `goal-wrapup` 驱动成品应用走完 create → 第一轮 → 自主 complete，并在持久会话日志与 ACP stdout 流中同时断言 plugin 来源的收尾注入、同轮内的收尾 assistant 消息与 `completed` 轮次结束。

## 曾考虑的替代方案

- **在 `update_goal` 的 UI 卡片上展示完成文本** — 拒绝：`complete` 不携带任何自由文本；新增 `summary` 参数会让面向用户的汇报走工具参数通道，而且依然砍掉了模型在结果之后的自然发言。
- **保留 `concludeTurn()` 并新增“再多一步纯文本”的 loop 原语** — 拒绝：为常规停止路径已经能提供的行为（只要没有结果终结轮次）增加新的 `agent-loop` 机制。
- **把指令写进工具结果内容** — 拒绝：goal 工具的规范输出是被程序化消费的紧凑 JSON；在其中混入散文指令会把模型侧约定和工具的可回放值搅在一起。

## Consequences

每个自主 goal 都以一条面向用户的收尾消息结束，而非一张裸工具卡片，代价是每个 goal 生命周期一次模型请求。`concludeTurn()` 保留其 loop 语义，但在 subagent 结构化输出之外失去了唯一的一方调用者。快照场景现在可以通过 `{{fromRequest:...}}` 脚本化只在运行时才存在的值，为任何“回显 id”类工具流程（不限于 goal）解锁 keyless 覆盖。
