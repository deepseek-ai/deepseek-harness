---
kind: upgrade-guide
description: "更新直接依赖和配置中引用的 macOS Computer Use 提供方名称。"
---

# macOS Computer Use 提供方名称

[English](guide.md) | 中文

## 变更

macOS 提供方的包名改为 `@deepseek-ai/dsh-cua-macos`，Cordis 插件名改为 `cua-macos`。Computer Use 组合使用配置行 ID `cua-macos` 挂载该包。只启用组合的配置档会自动使用新包。

## 迁移

1. 将直接依赖和导入中的 `@deepseek-ai/dsh-experimental-cua-macos` 替换为 `@deepseek-ai/dsh-cua-macos`，并更新锁文件。如果自定义 Cordis 配置的 `name` 引用了旧包，也要更新。
2. 如果主目录或配置档的 `cordis.patch.yml` 及其他覆盖配置指向组合提供的 macOS 后端，将 `id: cua` 改为 `id: cua-macos`。保留完整的 `config`，包括已设置的 `agentPreset`、`helperPath` 和 `sourceSigning`。自定义组合中自行指定的 ID 可以继续使用。
3. 在 macOS 上启用 Computer Use 后，运行 `dsh --profile web --dump-config`，将 `web` 换成实际使用的配置档。检查 `cua-macos` 行是否加载了新包，以及各项配置是否符合预期。
