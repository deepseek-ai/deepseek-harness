# Agent Note: 保留单一公开停止原语

Status: implemented
Archived: 2026-09-04

[English](2026-06-20-public-agent-stop-api.md) | 中文

## 问题

公共 `Agent` handle 暴露了两种相互重叠的在途工作停止方式：仅针对步骤的 `abort()` 和感知队列的 `cancel()`。前者保留已排队输入，后者原本只暴露广义默认行为，该行为会清除已排队和 steering（中途引导）工作，同时中止活动轮次。`cancel(cause, { keepInbox: true })` 现在无需暴露私有轮次 holder 即可覆盖生产环境的 Web 停止策略；ACP（Agent Client Protocol）保留广义取消，生命周期拥有者则通过 `AgentHandle.dispose()` 拆除 agent（智能体）。没有生产调用方需要一个裸的、仅针对步骤的 abort。

行为差异确实存在，但实际交付的代码不需要独立的更窄动词。AgentLoop 为整个轮次拥有一个私有取消 holder。`cancel(cause, options?)` 携带显式且类型化的 `user` 或 `parent` 原因；其广义默认行为丢弃待处理输入，`keepInbox` 则为后续轮次保留待处理工作。dispose（资源释放）仍是单独的生命周期中断。完整的归属与传播约定位于[显式轮次取消 Agent Note](../architecture/2026-07-16-explicit-turn-cancellation.zh.md)。

多余的公开接口使循环承载了一个本质上属于内部拆卸的公开动词。带选项的 `cancel()` 可以表达调用方策略，而无需暴露第二个 holder 形态的操作。

## 决策

`cancel()` 是 `Agent` 上唯一的公共*停止*原语。生命周期拥有者使用 `AgentHandle.dispose()` 停止并注销 agent；非拥有者使用广义 `cancel()` 放弃当前和已排队工作，或使用 `keepInbox` 中止活动轮次并保留待处理工作。实现保留一个私有轮次取消 holder，但它不属于面向插件的 `Agent` 约定。[Web 停止决策](../bug-fix/2026-07-31-web-stop-preserves-queue.zh.md)是生产环境中的 `keepInbox` 消费方。

`whenIdle()` **保留**为公开的完全停稳观测原语（agent 退出 `running` 状态并完全停稳后 resolve，已处于 idle 时立即 resolve，dispose 后等待循环退出）。它不是停止动词；它是非所有者在不 dispose agent 的前提下观测停止*完成*的方式。它的活跃消费方是 ACP 和通过此公开约定等待结算的 agent 测试（`packages/acp/acp/tests`、`packages/core/agent-loop/tests`）；生产环境的 ACP 桥接层拥有其 agent 并通过 `AgentHandle.dispose()` 销毁它们，因此 `packages/acp/acp/src` 本身没有 `whenIdle()` 调用。

公共 `abort()` 已不存在，disposer 仍为异步并等待循环停止。测试通过公共类型化原因和显式 signal API 验证取消，而不会伸入 holder 内部。

## 曾考虑的替代方案

**同时移除 `whenIdle()`**：最初提案的形态，在对照代码验证前提后被推翻：它是承重的完全停稳原语，能安全处理等待者结算与替换轮次竞态，迫使消费方手动观测 `running`→`idle` 转换正是防御性模式所警告的脆弱路径。

## 验证

`Agent` 不再暴露公开的 `abort()`，而 `cancel()`、`whenIdle()` 和 `steer()` 保留；ACP 取消调用广义 `cancel()`，Web 停止调用 `cancel(..., { keepInbox: true })`，拆卸则通过 handle 的 dispose 等待完全停稳。`whenIdle()` 在完全停稳时为非所有者观测者 resolve；测试套件覆盖取消和 dispose 这两条受支持的停止路径。

## 后果

插件可以通过 `keepInbox` 在保留已排队提示词的同时中止活动轮次，但不能只中止某一个模型／工具步骤而让该轮次继续运行。仅步骤用例需要具名消费方和更窄约定；暴露私有循环机制仍缺乏正当理由。

## 相关

本 Agent Note 只移除冗余的停止动词。轮次中途 steering 仍是一条有意保留的消息路径；完全停稳观察仍通过 `whenIdle()` 完成。最终的消息投递接口包括 `followup()`、`steer()` 和 `inject()`；停止与观察仍通过 `cancel()` 和 `whenIdle()` 完成。
