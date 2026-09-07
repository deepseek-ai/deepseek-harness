# Agent Note: 删除 agent-spine demo 包

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-remove-agent-spine-demo.md) | 中文

## 问题

`@deepseek-ai/dsh-agent-spine-demo` 的名称与位置将它描述为示例，但它实际暴露了带大型合并配置的公开组合插件。其唯一交付消费方是 `dsh-sdk-minimal`，其中一个插件配置行隐藏了必需的 agent（智能体）运行时，而该组合包的目的本是提供完整、显式的配置树。其他消费方全部是测试。该包还重复了已归 `dsh-base` 所有的组合策略，却没有提供可独立演进的能力。

## 决策

删除该包、其公开配置与 `packages/examples` 分组，不保留别名。`dsh-sdk-minimal` 现在直接在 patch 中声明 timer、LLM（大语言模型）、会话、标题、系统提示词、工具、agent、重试、本地后台任务、不变量注册表与配套入口，以及 agent loop（智能体循环）配置行。它仍然省略工作区指令、skill（技能）、面向模型的后台任务工具、goal、subagent、settings 与 `dsh-base` 的其他功能。

Profile 集成测试通过 `loadProfile` 加载已交付 profile 与组合包 patch，再把生产 patch 和窄测试 `*.patch.yml` 文件交给应用启动使用的同一个根 `cordis:include`。测试 patch 覆盖模拟提供方或模型、隔离持久化和被测插件，不会重新创建必需 agent 配置树。不覆盖 profile 集成的 SDK server 单元测试在本地挂载 `dsh-agent-loop-testkit` 与 `dsh-agent-loop`。

## 验证

`sdk-minimal` 组合包测试检查其精确配置行清单与所有方配置，构建后的 CLI 测试检查输出的 profile 配置树。真实 Loader fixture 以测试 overlay 覆盖已交付组合包层，SDK server 测试则覆盖包内 testkit 组合。配置、包、不变量、生成文档、构建、hygiene 与快照门禁验证没有现行产品或测试导入已删除包。

## 考虑过的替代方案

**用 `dsh-base` 替换该包。** 拒绝，因为 `dsh-base` 是完整产品基础，而 `sdk-minimal` 刻意省略其 settings、凭据、工作区上下文、skill、goal、压缩、遥测、subagent 与广泛工具配置行。用 base 替换会改变 profile，而不是移除间接层。

**重命名并移动公开组合包。** 拒绝，因为没有两个交付产品共享该组合。重命名后的包仍会保留合并配置转发，并在 profile patch 中隐藏配置行所有方。

**为测试保留私有的必需运行时组合。** 拒绝，因为私有 TypeScript 配置树仍然会重复生产组合策略，并可能偏离已交付 profile。测试 overlay 可以保持显式，同时不拥有其未修改的配置行。

## 后果

预发布包导入与合并配置被删除。`sdk-minimal` 变得更长，但每个挂载功能都单独可见、可 patch。`dsh-base` 仍是完整产品组合，不能替代更小的配置树。已交付 base 或模式组合包发生变化时，profile 集成测试现在也会随之变化，因此其 Loader 与 recorded-session 覆盖反映生产配置树，而非平行的测试组合。
