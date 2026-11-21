---
kind: upgrade-guide
description: "更新指定路径的 macOS Computer Use helper，以支持近期活动时长配置。"
---

# 更新指定路径的 macOS helper

[English](guide.md) | 中文

## 变更

macOS 连接握手新增字段 `recentActivityWindowMs`，旧版 helper 应用会拒绝这个字段。这影响配置了 `helperPath` 的 profile，以及直接连接原生 helper 的自定义客户端；默认随包或源码准备的 helper 会随提供方更新。

## 迁移

1. 从对应 profile 补丁中移除 `helperPath`，使用提供方管理的组件；或按照[原生构建说明](../../../../packages/experimental/cua-macos/native/README.zh.md#build-and-service)，用相同包版本的源码重新构建指定组件。
2. 自定义原生客户端需要在 `hello.config` 中加入 `recentActivityWindowMs`，默认值为 60000 毫秒。可填写 1 至 2147483647 的整数，或填写 `"off"` 关闭活动检测和提醒。
3. 调用 `cua.getCapabilities()`，确认连接返回权限状态且没有握手错误。操作系统权限仍需满足原有要求。
