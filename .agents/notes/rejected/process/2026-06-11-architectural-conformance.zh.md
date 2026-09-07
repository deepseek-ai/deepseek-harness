# Agent Note: 架构一致性——依赖规则与适配器套件

Status: rejected — premise gone: plugins depend on dsh-agent-loop by design; dsh-llm/invariant and the hygiene dependency gates own conformance

[English](2026-06-11-architectural-conformance.md) | 中文

## 问题

目前有两项架构保证仅存在于行文中：（1）没有任何组件依赖具体的 agent loop（智能体循环）包（[微内核承诺](../../implemented/architecture/2026-06-11-microkernel-event-taxonomy.zh.md)）；（2）每个 LlmAdapter 都正确遵循分片协议。二者都应由机制强制执行（[质量门禁原则](../../implemented/process/2026-06-11-quality-gates.zh.md)）。

## 提案

**dependency-cruiser** 配合以下规则：

- `packages/*`（除 agent-loop 自身的测试和 examples/ 外）禁止导入 `@deepseek-ai/dsh-agent-loop`。
- 禁止跨包深层导入（`@deepseek-ai/dsh-*/src/...` 路径）——只允许使用公开入口点。
- packages/ 内禁止出现循环依赖。
- `vendor/*` 禁止从 `packages/*` 导入。
- 分层：dsh-llm 不导入其他 dsh 包；dsh-session 仅导入 dsh-llm；以此类推（packages/README.md 中的依赖表，强制执行）。

**适配器一致性套件**位于 dsh-llm（`@deepseek-ai/dsh-llm/conformance`）：一个以适配器工厂为参数的可复用 vitest 套件，用于断言分片协议约定，包括每个块内的索引单调递增、某个索引出现 `block-end` 后不再接收增量、恰好出现一个 `finish`、用量至多出现一次、每个 `tool-call-delta` 都携带调用 id，并且及时响应 abort。当前先对 mock 运行；DeepSeek V4 适配器从第一天起继承该套件。还可以选择提供开发模式下的 `strictAdapter()` 包装层，在调试标志开启时于运行时强制执行相同规则（与 [开发模式不变式](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.zh.md) 配对）。

## 计划

先落地 dependency-cruiser 配置与 CI 步骤（约一小时工作量，换来永久保证）；一致性套件随其首个消费方测试（针对 MockAdapter）一起落地，并作为 V4 适配器阶段的前置条件。

## 验收标准

- dependency-cruiser 在 CI 中运行上述规则族；违规导入导致构建失败。
- 一致性套件对 mock 适配器和两个正式适配器运行，新适配器包通过调用该套件并传入自己的工厂即可继承测试。

## 风险

随着包的增加，dep-cruiser 规则需要维护——规则应基于模式（`dsh-*`）而非逐一枚举。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
