# Agent Note: 将唯一的压缩后端并入服务包

Status: rejected — 计划增加更多压缩后端，因此 Service Definition 包与 basic 提供方包继续分离。

[English](2026-07-19-fold-compaction-package-split.md) | 中文

## 问题

压缩（compaction）目前拆分在两个包中：`@deepseek-ai/dsh-compaction` 拥有一个含两个方法的抽象服务和共享类型，`@deepseek-ai/dsh-compaction-basic` 拥有唯一的完整提供方。交付配置只加载 basic 包，除了该提供方外，没有生产包独立消费 Service Definition 包。

该拆分增加了一份包 manifest（元数据清单）、README、项目边界、依赖边、抽象转发类、生成目录项和组合接线，却没有实际的后端替换用例。[能力 seam 决策](../../implemented/architecture/2026-06-13-capability-seams.zh.md)要求接口、实现和消费方都必须真实存在，而不能预先拆分；[历史压缩决策](../../archived/feature/2026-06-18-compaction-capability-seam.md)也记录了独立消费方的实现仍被推迟。

## 提案

把 basic 实现移入 `@deepseek-ai/dsh-compaction`，并删除 `@deepseek-ai/dsh-compaction-basic`。`ctx.compaction`、`CompactionResult`、共享 transcript（文本记录）和工具配对辅助方法、现有配置以及具体压缩算法都由一个包负责。

保留 `summarize()` 作为受保护的自定义钩子。部署专用的摘要器可以通过继承或拦截现有 LLM（大语言模型）调用完成定制，无需第二个能力包。只有在第二个完整后端与独立消费方确实需要替换实现时，才重新引入独立的 Service Definition 包。

如果本提案获准，应同步修订已实现的压缩决策与[可回忆压缩提案](../../proposed/feature/2026-07-06-recallable-compaction.zh.md)，使包所有权只有一处持久说明。

## 备选方案

**为可能出现的远程或回忆后端保留拆分。** 一种可能的未来实现不足以支撑当前包边界。回忆功能会增加压缩结果的消费方，但不一定增加另一种实现；远程摘要器也可以使用受保护钩子。

**将提供方包名用于 Service Definition 包。** 如果保留 `compaction-basic` 作为最终名称，产品服务会看起来像一个可选后端。`compact` 已经是 `ctx.compaction` 使用的稳定服务标识，更适合作为单包所有者。

## 验收标准

- 删除 `@deepseek-ai/dsh-compaction-basic` 及其工作区和包元数据。
- `@deepseek-ai/dsh-compaction` 拥有当前配置、插件类、算法、类型、事件和共享辅助方法。
- 现有部署可以使用等效配置加载保留的包，模型可见行为等效。
- 自动压缩和手动压缩保留取消、锁、token 用量、工具配对、持久事件、引用的来源事件 seq、重试收敛和 transcript 渲染行为。
- loader 组合、单元、失控轮次、取消、快照和真实模型压缩测试全部通过；生成目录与模块图保持最新。

## 风险

这是一项有意实施的预发布包名收缩。加载 `@deepseek-ai/dsh-compaction-basic` 的嵌入方必须切换包，未来的后端替换也需要重新提取边界。只有在仍然只有一个完整实现时，这项代价才可接受；如果第二个后端先行落地，应重新评估是否接纳本提案。
