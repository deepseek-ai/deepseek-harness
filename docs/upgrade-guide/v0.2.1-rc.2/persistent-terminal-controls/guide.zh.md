---
kind: upgrade-guide
description: "持久终端组合包开关移出插件页，仍可通过 profile 配置启用或关闭组合包。"
---

# 通过 profile 配置管理持久终端

[English](guide.md) | 中文

## 变更

Web 和 Desktop 的插件列表和详情页不再显示持久终端组合包，包括此前已启用它的 profile。包及已有启用状态保持不变。minimal 预设自带的持久 shell 独立于此组合包。

## 迁移

1. 保留已有选择无需操作。如需更改，打开 `$DSH_HOME/profiles/<name>/package.json`，home 默认为 `~/.dsh`，`<name>` 是运行中的 profile，例如 `web` 或 `desktop`。
2. 从 `dsh.profile.bundles` 中移除 `@deepseek-ai/dsh-experimental-terminal-bundle` 即可关闭，加入即可启用。保留其他条目和依赖。
3. 重启同一个 profile 后生效。对于 CLI 管理的 profile，运行 `dsh --profile <name> --dump-config`：只有选中此组合包时，配置才包含 `optional-persistent-terminals` 分组。详见 [profile 参考](../../../../apps/cli/reference/README.zh.md#profile-boot)。
