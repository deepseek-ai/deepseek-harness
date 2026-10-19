---
kind: upgrade-guide
description: "AccountBonusNotification 提供未经校验的可选元数据，并允许通知永不过期。"
---

# 更新账号通知使用方

[English](guide.md) | 中文

## 变更

`DeepSeekAccount.getUnnotifiedBonuses()` 和 `account/getUnnotifiedBonuses` 返回的公开类型 `AccountBonusNotification` 保留 `campaign`、`amount`、`currency` 和 `grantedAt`，作为类型为 `JsonValue` 的可选元数据，不做校验。通知保留 `orderId`、`message` 和 `expiresAt`，并新增可选的 `title`。空字符串 `expiresAt` 表示通知永不过期。`orderId` 接受任意字符串，不再要求 UUID 格式。

## 迁移

1. 使用可选元数据前先收窄类型；这些值不再保证存在或符合原有格式。展示 `message`，在 `title` 缺省时使用客户端默认标题。
2. 解析时间戳前，将空字符串 `expiresAt` 视为永不过期。确认通知时原样传递 `orderId`。
3. 更新提供者测试夹具以使用当前字段。确认非 UUID 标识、空过期时间的通知可以展示并确认。
