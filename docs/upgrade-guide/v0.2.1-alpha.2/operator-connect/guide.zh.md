---
kind: upgrade-guide
description: "非页面 Client 默认不参与转发交互，并使用不带浏览器恢复的原始流。"
---

# 为非页面客户端选择交互参与模式

[English](guide.md) | 中文

## 变更

非页面 Connection 安装默认 `interactions: 'none'`。该模式不打开 `$events`，也不提供 `$on()` 和代际恢复辅助方法 `$stream()`；生成的 unary 和原始流方法仍可使用。浏览器认证、既有 Cookie、共享 Peer 与恢复行为均不变，无需重新认证。

## 迁移

1. 使用手动重定向处理，在 `GET /connect?token=<launch-token>&interactions=none` 交换 launch token。将返回的 API Cookie 放在客户端独立存储中，供 HTTP 和返回的 302 Location 所指的生命周期 WebSocket 使用；HTTP 无需等待 socket 打开。
2. 被动流调用直接使用生成的原始流方法，不使用 `$stream()`。生命周期连接关闭或 Host 重启后，重试前先重新 connect。
3. 如果调用方确实要回答转发交互，请请求 `interactions=answer`，并用相同模式安装 Connection。确认被动调用方在两个事件端点被拒绝，而回答型调用方可以订阅。
