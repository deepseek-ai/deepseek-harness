---
kind: upgrade-guide
description: "更新直接依赖和配置中引用的 macOS Computer Use 提供方名称。"
---

# macOS Computer Use 提供方名称

[English](guide.md) | 中文

## 变更

Computer Use 组合会自动加载改名后的 macOS 提供方。直接依赖或覆盖配置使用的名称如下。

| 名称 | 旧值 | 新值 |
|---|---|---|
| npm 包 | `@deepseek-ai/dsh-experimental-cua-macos` | `@deepseek-ai/dsh-cua-macos` |
| Cordis 插件 | `experimental-cua-macos` | `cua-macos` |
| 组合配置行 ID | `cua` | `cua-macos` |

## 迁移

1. 后续版本使用新包名发布。将直接依赖和导入改为 `@deepseek-ai/dsh-cua-macos`，并更新锁文件。如果自定义 Cordis 配置的 `name` 引用了旧包，也要更新。
2. 如果主目录或配置档的 `cordis.patch.yml` 及其他覆盖配置指向组合提供的 macOS 后端，将 `id: cua` 改为 `id: cua-macos`。保留完整的 `config`，包括已设置的 `agentPreset`、`helperPath` 和 `sourceSigning`。如果仍指向组合的旧配置行，`--dump-config` 会提示 `patch: entry "cua" not found`，Loader 会跳过这条覆盖配置。如果其他配置也没有指定 `sourceSigning`，源码构建会使用默认的临时签名，重新构建 helper 后，macOS 可能再次要求授权。自定义组合可以保留自行指定的配置行 ID。
3. 在 macOS 上启用 Computer Use 后，运行 `dsh --profile web --dump-config`，将 `web` 换成实际使用的配置档。检查 `cua-macos` 行是否加载了新包，以及各项配置是否符合预期。
