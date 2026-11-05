---
kind: upgrade-guide
description: "固定的 1017 模型角标包已移除，模型角标改由 DeepSeek 模型列表下发。"
---
# `ui-deepseek-model-label-1017` 包已移除

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 及其在 Web bundle 中的 `ui-deepseek-model-label-1017` 条目已移除，该包不再发布新版本。composer 模型选择器显示 DeepSeek `GET /models` 列表为模型声明的角标；列表没有声明角标时，`DeepSeek-V4.1-Flash` 不再显示 `1017`。停用或修改该条目的 profile patch 不再匹配任何条目，启动时会警告找不到该条目并跳过这条 patch。

## 迁移

1. 从 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 以及通过 `--patch` 传入的 overlay 中，删除 `id` 为 `ui-deepseek-model-label-1017` 的 patch，连同其中的 `disabled` 或其他字段。
2. 若有包在依赖中列出 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`，将其删除。
3. 如需改变模型名称或角标的显示方式，向 `conversation.input.model.label` slot 注册组件；其 owner props 携带目录中的 `model.badge`（[名称扩展](../../../../packages/client/ui-model-selection/README.zh.md#use-this-package)）。
4. 重启 DSH，确认启动输出中没有找不到 `ui-deepseek-model-label-1017` 条目的警告。
