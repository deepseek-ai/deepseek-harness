---
kind: upgrade-guide
description: "pi-ai 的 Azure 提供方路由从 azure-openai-responses 更名为 azure。"
---

# Azure 提供方路由更名

[English](guide.md) | 中文

## 变更

已安装的 pi-ai 目录使用 `azure` 标识 Azure 提供方，替代 `azure-openai-responses`。`azure` 路由同时包含 Responses 和 Chat Completions 模型。Responses API 标识仍为 `azure-openai-responses`，`AZURE_OPENAI_*` 环境变量名称也保持不变。使用旧提供方键的配置和模型选择无法再解析 Azure 目录。

## 迁移

1. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 或其他提供配置的层中，找到 `llm-pi-ai` 配置，将 `config.providers.azure-openai-responses` 改为 `config.providers.azure`。保留原有字段及任何 `apiKeyEnv` 引用。
2. 在 `models` 中使用目录模型 ID；自定义 Azure 部署名称通过 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 映射。混合协议目录无法为目录外的模型 ID 推断协议。显式设置路由级 `api` 会覆盖该路由所有模型的协议，并不表示选择 Azure 提供方。
3. 将显式请求及默认模型配置中的提供方改为 `azure`，继续现有 Session 时重新选择 Azure 模型。若密钥存储在旧条目下，请在“设置 → 模型”中配置新的 Azure 条目。不要修改历史 Session 事件。
4. 确认“设置 → 模型”提供 `azure` 且列出预期模型，再向所配置的部署发送一条简短请求。
