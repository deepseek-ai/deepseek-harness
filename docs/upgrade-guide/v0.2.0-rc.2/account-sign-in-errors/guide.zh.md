---
kind: upgrade-guide
description: "账号登录传输失败现在报告 no-response，而非 network。"
---

# 账号登录错误码

[English](guide.md) | 中文

## 变更

`SignInErrorCode` 新增 `no-response`。当 fetch 在返回 Response 前失败（包括单次请求超时）时，`account/getState`、`account/startSignIn` 和 `account/watch` 返回的账号状态报告此代码。这些失败此前报告 `network`。HTTP 响应错误仍报告 `network`；授权尝试到期仍报告 `expired`。

## 迁移

1. 在账号 API 或 `@deepseek-ai/dsh-deepseek-account` 的客户端中，为 `SignInAttemptView.errorCode` 的校验器和穷尽处理逻辑添加 `no-response`。
2. 对 `no-response` 提示检查网络。对 `network` 保留通用失败处理；该代码也涵盖 HTTP 和账号详情获取失败。
3. 确认客户端接受 `errorCode: 'no-response'` 的登录失败状态并提供重试，同时 HTTP 错误响应仍使用通用失败处理。
