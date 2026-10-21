---
kind: upgrade-guide
description: "DeepSeekAccount.watch 默认不再通知 Platform 身份变化，订阅者必须显式启用。"
---

# 显式订阅账号身份变化

[English](guide.md) | 中文

## 变更

公开方法 `DeepSeekAccount.watch(signal)` 原先会在资料查询首次补齐或改变缓存的 Platform 用户 ID 时发出快照。现在默认仅通知账号状态变化。通过该流刷新 `getPlatformSession()` 的插件必须显式订阅身份变化。凭证替换和登录状态变化仍会通知所有订阅者。

## 迁移

1. 在刷新 Platform 会话或同步其用户 ID 的插件中查找 `deepseekAccount.watch(signal)` 调用。
2. 将这些调用改为 `deepseekAccount.watch(signal, true)`。只需要登录和凭证状态的账号界面订阅保持不变。
3. 确认 `getProfile()` 返回 ready 结果且用户 ID 首次出现或变化时，订阅被唤醒并重新读取 `getPlatformSession()`。重复读取同一 ID 不会再次发出身份通知。
