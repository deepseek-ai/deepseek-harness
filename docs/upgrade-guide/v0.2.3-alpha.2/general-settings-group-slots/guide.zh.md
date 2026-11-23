---
kind: upgrade-guide
description: "第三方替换通用设置内置行时，必须改为注册到该行所属分组的设置行 slot，而不是 settings.general.item。"
---

# 通用设置内置行使用分组设置行 slot

[English](guide.md) | 中文

## 变更

从 v0.2.3-alpha.2 升级时，部分内置行从 `settings.general.item` 移到分组拥有的设置行 slot。此前通过旧 slot 和内置行 ID 替换其展示的第三方注册项，不再遮蔽该行，而是在默认「常规」分组中添加一个独立的行。

通过 `settings.general.item` 添加的贡献仍受支持。语言、外观和字体偏好保留在该 slot 中。设置键与已持久化的偏好值不变。

## 迁移

1. 在客户端插件的 `ctx.slots.inject` 和 `ctx.slots.register` 调用中，为每个已移动的内置行修改目标 slot。保留设置行 ID 和用于有意遮蔽的 `priority`：

| 设置行 ID | 目标设置行 slot |
|---|---|
| `permission`、`action-cards`、`transcript-view`、`developer-tools`、`performance-usage` | `settings.general.group.display.item` |
| `composer-enter`、`shortcuts`、`link-opening` | `settings.general.group.interaction.item` |
| `session-log-deepseek` | `settings.general.group.data.item` |
| `current-version`、`desktop-update-channel` | `settings.general.group.updates.item` |

2. 将组件的 `PropsRuntime` 类型更新为所选设置行 slot。例如，`developer-tools` 替换项使用 `PropsRuntime<'settings.general.group.display.item'>`。通过 slot 名称选择分组，不要添加 `groupId` 属性。
3. 重新加载插件并打开通用设置。确认替换项在目标分组中只出现一次，且内置展示已被替换。禁用替换项，确认其所属功能可用时内置行会恢复。

添加设置行或自定义分组时，请参考[通用设置注册示例](../../../../packages/client/ui-settings-general/README.zh.md#the-general-section)。自定义分组通过声明合并把确切的设置行子 key 加入 `SlotMap`，以 `id`、本地化 `label` 和 `order` 注册 `settings.general.group` 条目，并拥有子 slot 的运行时声明；页面提供标题和卡片。
