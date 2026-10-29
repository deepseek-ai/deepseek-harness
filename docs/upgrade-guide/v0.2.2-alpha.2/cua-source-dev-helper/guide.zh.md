---
kind: upgrade-guide
description: "源码构建的 Computer Use helper 使用独立的开发版 Bundle ID，需要重新授予一次 macOS 权限。"
---

# 源码构建的 Computer Use helper 身份

[English](guide.md) | 中文

## 变更

此前源码检出构建的 `DSH Computer Use.app` 使用正式版 Bundle ID `com.deepseek.harness.computer-use` 和临时签名。现在构建的是 `DSH Computer Use Dev`，Bundle ID 为 `com.deepseek.harness.computer-use.dev`。旧条目上的辅助功能和屏幕录制授权不适用于它。桌面端和 npm 安装版不变。

## 迁移

1. 每个 macOS 用户运行一次 `pnpm --dir packages/experimental/cua-macos run dev-signing:setup`，之后的构建和其他 worktree 都能沿用授权。未运行时，每次构建内容变化都使用临时签名并重新要求授权。
2. 从源码检出启动 DSH 并调用 Computer Use，在系统设置中给 `DSH Computer Use Dev` 授予辅助功能和屏幕录制权限。
3. 确认 `getCapabilities` 报告两项权限均为 `true`。只有在没有已安装的 DSH 使用旧的 `DSH Computer Use` 条目时才移除它。
4. 撤销初始化时运行 `pnpm --dir packages/experimental/cua-macos run dev-signing:remove`，并在系统设置中移除 `DSH Computer Use Dev` 条目。
