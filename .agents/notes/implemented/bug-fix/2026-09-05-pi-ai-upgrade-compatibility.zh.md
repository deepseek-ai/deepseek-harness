# Agent Note: pi-ai 升级兼容性

Status: implemented

[English](2026-09-05-pi-ai-upgrade-compatibility.md) | 中文

## Problem

pi-ai 适配器显式分类上游兼容字段，并且只持久化后续请求需要的回放元数据。SDK 升级可能在不改变 Harness 提供方无关 API 的情况下为任一集合新增字段。未分类的配置字段会导致编译失败；遗漏回放元数据则可能静默改变后续提供方请求。

## Decision

适配器遵循 [pi-ai 0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/CHANGELOG.md)。`thinkingTokenBudgetField`、`vllmPriority` 和 `supportsMaxOutputTokens` 是显式启用的网关控制；`thinking.budget` 加入现有模板占位符。SDK 拥有预算解析和序列化。`supportsMidConvoEffort` 和 `allowedFallbackModels` 仍由目录拥有，因为其正确性依赖确切的 Anthropic 传输、模型能力和回退定价。

可选的 `providerThinkingLevel` 保存在适配器 replay-v2 响应元数据中，让 Anthropic 历史保留提供方原生 effort。缺失仍然有效；回放版本与已发布 Session 格式均不改变。回放来源保留请求模型，`responseModel` 则保留 Anthropic 别名解析或回退后的模型。重建会恢复该原生模型，让 pi-ai 继续应用其跨模型签名规则。提供方无关的 LLM API 保持不变；[按提供方路由的回放归属规则](../architecture/2026-07-14-provider-routed-llm-adapters.zh.md) 仍然适用。0.84.2 Anthropic 适配器[从请求初始化 `model`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/anthropic-messages.ts#L510-L515)，并且[在消息开始时只记录响应 ID 和用量](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/anthropic-messages.ts#L589-L605)。它从不写入 `responseModel`，因此其回放记录保留请求模型，不携带原生模型元数据。

## Alternatives considered

**保留所有新增字段为不可配置。** 这会把部署拥有的网关控制误分类为目录事实：上游明确不在生成目录中设置预算字段选择和 vLLM 优先级。

**开放所有新增字段。** 这会允许任意网关在缺少目录证据时声明支持模型专属的 Anthropic effort 与回退能力，而这些证据正是相关功能有效的依据。

## Consequences

编译期覆盖保留显式字段分类。[兼容性测试](../../../../packages/llm/llm-pi-ai/tests/compat-upgrade.spec.ts) 覆盖 schema 接受、无效值、协议适用范围及物化，且不改变默认值。[回放转换测试](../../../../packages/llm/llm-pi-ai/tests/convert.spec.ts) 覆盖可选 effort 的保留。混合协议目录测试使用已安装的 OpenCode 目录。提供方行为仍由上游拥有；真实提供方验证与无需密钥的适配器测试分开。
