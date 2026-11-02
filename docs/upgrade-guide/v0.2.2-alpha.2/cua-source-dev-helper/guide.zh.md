---
kind: upgrade-guide
description: "源码构建的 Computer Use helper 使用独立的开发版 Bundle ID，需要重新授予一次 macOS 权限。"
---

# 源码构建的 Computer Use helper 身份

[English](guide.md) | 中文

## 变更

源码检出原先以临时签名构建 `DSH Computer Use.app`，使用正式版 Bundle ID `com.deepseek.harness.computer-use`。现在构建 `DSH Computer Use Dev.app`，使用 `com.deepseek.harness.computer-use.dev`。旧条目的辅助功能和屏幕录制授权不能沿用。Desktop 和 npm 安装版不变。源码构建默认仍为临时签名；固定身份由开发者在 DSH home 之外生成和维护，再通过配置指定。

## 迁移

1. 保持默认 `sourceSigning: ad-hoc` 即可使用临时签名。需要减少重新编译和跨 worktree 的授权次数时，按[开发者签名 skill](../../../../.agents/skills/dsh-cua-macos-signing/SKILL.md)生成或复用证书，并将 `sourceSigning: { identity, keychain }` 写入 DSH home 的 `cordis.patch.yml`；`keychain` 必须为绝对路径。
2. 从源码检出启动 DSH，调用 Computer Use，在系统设置中给 `DSH Computer Use Dev` 授予辅助功能和屏幕录制权限。
3. 确认 `getCapabilities` 的两项权限均为 `true`。使用固定签名时，在修改 Swift 源码重建和另一个 worktree 中分别复查。只有确认没有安装版 DSH 使用旧条目时，才移除旧 `DSH Computer Use` 条目。
4. 钥匙串锁定后，按 skill 重新运行 setup 解锁并复用现有身份。停止使用时改回 `ad-hoc` 或移除该配置，再按 skill 删除身份；删除 DSH home 不会删除开发者钥匙串。
