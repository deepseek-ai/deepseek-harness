---
kind: upgrade-guide
description: "将账号插件组合与 Remote 导入迁移到具体的 deepseek-account 服务。"
---

# 账号服务与 Remote 导入

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-deepseek-account` 是具体的 `DeepSeekAccount` 服务，拥有浏览器登录、已存储凭证和 `account` Remote 命名空间。抽象账号类、`@deepseek-ai/dsh-deepseek-account-platform` 和 `@deepseek-ai/dsh-api-account-controller` 被移除。已有 `ctx.deepseekAccount` 和 `ctx.remote.account` 操作保留名称和参数。凭据相关的 Host 专用方法不会成为 Remote 操作。`/types` 出口仍可用，且不会加载服务实现。

已存储凭证保留 `deepseek-account-platform/default` 和 `deepseek-account-platform/device` key；这次包变更不要求重新登录。

## 迁移

1. 将自定义插件行和依赖中的 `@deepseek-ai/dsh-deepseek-account-platform` 替换为 `@deepseek-ai/dsh-deepseek-account`。保留现有 `deepseek-account` 行 id 和配置。移除所有 `account-controller` 行及其包依赖。
2. 将 `PlatformAccount` 导入改为 `DeepSeekAccount`。该类为具体实现；继承原抽象账号定义的自定义子类需要调整。从 `@deepseek-ai/dsh-deepseek-account/types` 导入共享类型的现有代码保持有效。
3. 将旧服务或 controller 的 `/remote`、`/typert` 导入替换为 `@deepseek-ai/dsh-deepseek-account/remote` 和 `@deepseek-ai/dsh-deepseek-account/typert`。
4. 从 `@deepseek-ai/dsh-deepseek-account/client-metadata` 导入 Platform 请求头和 Cookie 辅助函数。从 `DeepSeekAccount.Config` 读取配置 schema。不再直接调用 `installAccountTaskCancellation`：挂载服务时会安装该逻辑。`isRunningAccountTask` 为内部函数。
5. 重新构建自定义组合，验证登录、通知查询、退出和账号状态订阅取消。确认 Remote 导出不包含 `resolveToken`、`rejectToken`、`getPlatformSession` 和 `getDeviceIdentity`。
