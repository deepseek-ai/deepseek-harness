---
kind: upgrade-guide
description: "通用账号通知 API 替换赠金专用方法，通知请求改用 Harness 域名。"
---

# 更新账号通知使用方

[English](guide.md) | 中文

## 变更

`DeepSeekAccount.getNotifications()` 和 `account/getNotifications` 替换 `getUnnotifiedBonuses()`，返回的 `AccountNotificationBatch.notifications` 包含不透明字符串 `id`、`createdAt`、可为 null 的 `displayUntil`、本地化的 `title` 与 `body`、有序的 `actions`，以及可选 JSON `data`。批次还要求提供 `nextPollAfterSeconds`，由接口字段 `next_poll_after` 投影。赠金元数据放入 `data`；赠金专用类型和字段移除。`reportNotificationEvent()` 替换 `ackBonusNotified()`，接收 `(id, event, client)`，以通知 ID 上报 `displayed`、`cta_clicked` 或 `dismissed` 事件。`getNotificationContent()` 按通知 ID 读取本地化内容，支持已消费通知，不改变消费状态。

`DeepSeekAccount.watch()` 和 `account/watch` 发出包含 `type` 和完整 `state` 的 `AccountUpdate`。首次订阅和登录进度使用 `snapshot`；凭据写入和删除使用 `credentials-changed`。

账号提供者新增 `harnessOrigin`，默认值为 `https://harness.deepseek.com`，用于通知 list、content 和 events。`platformOrigin` 保留 `https://platform.deepseek.com` 默认值，用于登录、资料、余额、退出登录、外部导航和原生内嵌页面。授权来源仍按 `platformOrigin` 校验。

`ui-account-notifications` 负责通知；`ui-settings-account` 提供已有账号状态、刷新事件和展示插槽。

## 迁移

1. 从 `update.state` 读取账号状态。收到 `credentials-changed` 事件或 Remote 流进入新一代连接时，清空通知状态，已登录时重启轮询；进度快照保留当前轮询。更新提供者、Remote 使用方和测试夹具，使用新字段、不透明字符串 ID 和必填的秒数间隔。列表解码逐条跳过格式错误或不支持的通知；列表外层格式错误仍使请求失败。
2. 移除通知方法的账号 ID 参数和批次的 accountId 字段。`getNotificationContent(id, client)` 和 `reportNotificationEvent(id, event, client)` 直接使用当前 token，不前置查询资料。凭据变化后终止旧请求、卡片与轮询，并丢弃迟到的响应。每次事件只上报一次；有效的 `acked: true` 和 `acked: false` 均结束本次尝试。上报失败保留本地卡片状态，不重试。展示后上报 `displayed`，所有非 dismiss 操作点击都上报 `cta_clicked`，不携带 action ID，主动关闭仅上报 `dismissed`。点击业务按钮保留卡片并立即执行操作，不等待上报；尚未展示就关闭时不补报展示事件；过期和账号清理不计为主动关闭。切换语言时，通过 `getNotificationContent()` 刷新当前卡片，保留位置，不重复上报展示事件。
3. 从 `ui-settings-account` 配置中移除 `bonusAckRetryDelayMs` 和 `bonusAckRetryMaxDelayMs`；事件上报没有重试配置。上报失败不撤销当前交互，也不重试该次上报。后续列表再次返回已关闭通知时，客户端会再次展示。
4. 保留已有的 `platformOrigin` 配置。私有部署和本机测试夹具将 `harnessOrigin` 设为各自的通知服务来源。确认仅 list、content 和 events 使用该来源；登录、资料、余额、退出登录和页面保留 `platformOrigin`。
5. 在账号设置旁加载 `@deepseek-ai/dsh-client-ui-account-notifications`。初始十分钟间隔不适用时，设置其新增的 `notificationPollIntervalMs` 选项。将通知状态及上报使用方迁移到新插件。确认两个插件共用一条账号流，包括重载通知插件之后。
