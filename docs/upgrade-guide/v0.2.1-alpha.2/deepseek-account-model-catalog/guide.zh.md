---
kind: upgrade-guide
description: "DeepSeek 账号路由不再接受 models 目录；模型由账号的模型列表提供，单个模型通过 modelOverrides 调整。"
---

# DeepSeek 账号模型改由账号的模型列表提供

[English](guide.md) | 中文

## 变更

`deepseek-account` 路由此前从 `llm-deepseek-account` 条目的 `models` 字段读取模型目录，模型页可以为账号编辑这份目录。现在该路由从账号的 `GET /models` 端点列出模型，在列表加载之前使用内置目录，单个模型只能通过 `modelOverrides` 调整；模型页不再为该路由提供编辑器。列表中的模型可以要求更新版本的 DeepSeek Harness，这样的模型会被隐藏，请求它时以 `CLIENT_UPGRADE_REQUIRED` 失败。条目中遗留的 `models` 字段，包括早先模型页编辑器保存的，会让插件在加载时报 `llm-deepseek-account: models is no longer configurable` 并停止，删除该字段之前桌面端和 Web 都不显示账号模型。没有保存过账号目录的已登录账号无需操作。

## 迁移

1. 打开 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，找到 `id: llm-deepseek-account` 的条目。
2. 删除其中的 `models` 字段。对改过字段的模型，只把改过的字段移到 `modelOverrides.<模型 id>` 下：

   ```yaml
   - id: llm-deepseek-account
     config:
       modelOverrides:
         deepseek-flash:
           maxTokens: 131072
   ```

3. 重启 DeepSeek Harness 并登录 DeepSeek 账号，确认模型选择器列出账号模型、模型页显示账号已登录。被列出的模型拒绝的覆盖，或指向未知模型的覆盖，会作为该账号的诊断信息显示在模型页上。
