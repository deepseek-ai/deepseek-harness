---
kind: upgrade-guide
description: "源码构建的 Computer Use helper 使用独立的开发版 Bundle ID，需要重新授予一次 macOS 权限。"
---

# 源码构建的 Computer Use helper 身份

[English](guide.md) | 中文

## 变更

此前源码检出构建的 `DSH Computer Use.app` 使用正式版 Bundle ID `com.deepseek.harness.computer-use` 和临时签名。现在构建的是 `DSH Computer Use Dev.app`，Bundle ID 为 `com.deepseek.harness.computer-use.dev`。旧条目上的辅助功能和屏幕录制授权不适用于它。桌面端和 npm 安装版不变。 源码构建现在默认在 `$DSH_HOME/computer-use-dev-signing` 中生成并复用固定签名身份，未设置 `DSH_HOME` 时使用 `~/.dsh`。

## 迁移

1. 默认的 `sourceSigning: local-identity` 无需手动 setup；各 worktree 使用同一 DSH home 即可复用身份。如需临时签名，在 `cordis.patch.yml` 的 `id: cua` 节点设置 `config.sourceSigning: ad-hoc`；如需已有证书，使用[用户签名配置](../../../../packages/experimental/cua-macos/README.zh.md#use-this-package)。
2. 从源码检出启动 DSH 并调用 Computer Use，在系统设置中给 `DSH Computer Use Dev` 授予辅助功能和屏幕录制权限。
3. 确认 `getCapabilities` 报告两项权限均为 `true`。只有在没有已安装的 DSH 使用旧的 `DSH Computer Use` 条目时才移除它。
4. 停用自动身份时，先改用临时签名或用户证书，再运行 `pnpm --dir packages/experimental/cua-macos run dev-signing:remove`。自定义 home 通过同一个 `DSH_HOME` 或 `--dsh-home <路径>` 指定。删除 DSH home 后会重新生成证书，届时需要重新授权。
