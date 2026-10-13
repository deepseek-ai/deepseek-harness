# Agent Note: 由 preset 拥有 subagent 组装

Status: implemented

[English](2026-10-09-preset-owned-subagent-composition.md) | 中文

## 问题

Agent Preset 已经组合 persona 和工具插件。独立的子级 persona 和工具过滤输入又增加了一处组装配置。已交付的子级过滤消费者是 standard、PTC 和 Cordis preset 中 spawn 与 fork 配置行的六份 schedule deny 列表；提醒执行器已经拒绝委派调用方。

## 决策

新 subagent 请求在提供方支持时选择 Agent Preset。persona 和工具来自其插件列表。fork 继承父级的 preset 代际；model 和 effort 选择保留现有配置。没有具体消费者时，不添加 preset 级过滤器或更细的插件拆分。

`dsh-tool-subagent` 在加载时拒绝已删除的 `persona` 和 `toolFilter` 键，包括空值，因为仅删除 Schemastery 字段不会拒绝未知配置。[升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.zh.md)说明失去的独立覆盖能力及迁移方法。

已发布的子级 descriptor 保留 persona 和 filter 字段、解析及冷恢复应用。[原组装记录](../feature/2026-07-12-subagent-persona-tool-filter-and-depth.zh.md)继续保留，以说明这些历史语义及独立的深度策略。[spawn preset 决策](../feature/2026-09-20-spawn-agent-preset-selection.zh.md)继续拥有选择与恢复身份的依据。

已交付配置中不含子级 schedule deny 列表。从 preset 继承的提醒 schema 仍然可见；每个执行器拒绝委派调用方。这消除了一处父级与 fork 子级 schema 差异的来源。子级会收到四个始终拒绝其调用的提醒 schema；尚未测量它们的提示成本或提供方缓存命中率改善，其他请求输入仍可能不同。

## 曾考虑的替代方案

**把过滤器移入各 preset。** 这保留了 schedule deny 列表和独立裁剪 fork 工具的能力，但仍有两种配置工具可用性的机制。新子级使用插件组装；fork 明确继承父级工具。

**在 preset 之外保留逐请求覆盖。** 这保留独立的 fork 覆盖、覆盖优先级规则和提供方能力标志。对新子级选择单一组装机制，放弃这项灵活性。

**随请求字段一起删除历史 descriptor 字段。** 这会改变或拒绝恢复的会话。简化新请求不意味着可以重写已发布的 Session 数据。

## 后果

preset 选择拥有新子级的 persona 和工具。fork 不能独立替换 persona 或裁剪继承工具，含已删除键的 JavaScript 配置会明确报错。历史恢复保留原有语义。针对性测试覆盖删除键的诊断、历史 persona／filter 恢复、继承的提醒 schema 及执行器拒绝；会话录制覆盖由 preset 控制的工具可用性、fork 提醒拒绝及消息指引。
