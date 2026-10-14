---
kind: upgrade-guide
description: "DeepSeek API Key 模型发现要求已配置凭据。"
---

# DeepSeek API Key 模型可见性

[English](guide.md) | 中文

## 变更

`deepseek-official` 路由此前在没有 API Key 时也会列出配置的模型。现在凭据缺失时返回空目录，因此桌面端和 Web 隐藏 DeepSeek 分组。模型发现会报告凭据格式错误和凭据读取失败。已保存或默认的选择不在目录中时，界面显示“请选择模型”，保存的选择保持不变。独立的 DeepSeek 账号路由仍使用账号登录。

## 迁移

1. 要使用 API Key 路由，请在设置 → 模型中配置密钥，或通过启动环境提供 `apiKeyEnv` 指定的凭据引用（默认为 `DEEPSEEK_API_KEY`）。
2. 重新打开模型选择器，确认 DeepSeek 分组出现。自定义模型发现消费者必须处理配置凭据前的空目录；模型列出不代表远端 API 已接受密钥。
