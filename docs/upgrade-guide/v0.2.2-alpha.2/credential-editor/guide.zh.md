---
kind: upgrade-guide
description: "已保存的 API 密钥显示为编辑器中的掩码值，清空已保存密钥会删除其覆盖。"
---
# 提供商编辑器中的已保存 API 密钥

[English](guide.md) | 中文

## 变更

提供商编辑器以掩码值显示已保存的 API 密钥，不再显示空字段。应用空字段会删除之前加载的密钥并恢复环境认证。「取消」保留已保存密钥。环境变量值从不加载到编辑器。

凭据提供方实现 `readStored(ref): Promise<string | undefined>`，仅返回托管值，不使用环境后备。仅允许所有者调用的 `credentials.readStored` Remote 方法向已打开的编辑器提供此值；普通元数据读取仍保持脱敏。

## 迁移

1. 保留加载的值即可保留已保存密钥，替换它可轮换密钥，清空并应用则使用环境认证。
2. 为自定义 `CredentialProvider` 子类实现 `readStored`；未存储非空值时返回 `undefined`。
3. 重新打开 DeepSeek 编辑器，确认已保存密钥显示为掩码。清空并应用后，确认字段为空且提示使用环境认证。
