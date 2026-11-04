---
kind: upgrade-guide
description: "实验终端 bundle 改为在 Web 侧栏打开 Agent 终端，并用 optional-terminal-panel 行替换 optional-terminal-bash 和 optional-terminal-pwsh 行。"
---
# 持久终端改为在 Web 侧栏打开

[English](guide.md) | 中文

## 变更

**持久终端** bundle（`@deepseek-ai/dsh-experimental-terminal-bundle`）原先通过 `@deepseek-ai/dsh-terminal-bash` 运行 Agent 终端：POSIX 上是不加载配置文件的 Bash，Windows 上是 PowerShell，人看不到这些终端，而且有终端打开时会拒绝切换沙箱模式。现在它的 `optional-persistent-terminals` 分组改为挂载 [`@deepseek-ai/dsh-terminal-panel`](../../../../packages/experimental/terminal-panel/README.zh.md)。每次 `terminal_open` 都会成为一个侧栏标签页，运行执行环境的默认 shell 并加载人的启动文件，Windows 上依次优先 `pwsh` 和 `powershell`；人可以在其中输入并接管。该 bundle 还会注册 `user_terminal_list` 和 `user_terminal_read`，并且需要挂载终端控制器的 Web 或 Desktop 组合。

针对已移除的 `optional-terminal-bash` 或 `optional-terminal-pwsh` 行的 profile patch，以及借这些行配置 `@deepseek-ai/dsh-terminal-bash` 选项（例如 `pollIntervalMs`）的 patch，都不再生效。没有终端控制器的 headless 或其他组合，不再能从这个 bundle 得到可用的 `shell` 后端。

## 迁移

1. 在 profile patch（`cordis.patch.yml`）中删除针对 id `optional-terminal-bash` 和 `optional-terminal-pwsh` 的条目。如需调整新后端，请以 `optional-terminal-panel` 为目标，使用[它的配置字段](../../../../packages/experimental/terminal-panel/README.zh.md#use-this-package)，例如 `config: { timeoutMs: 60000 }` 或 `config: { readUserTerminals: false }`。
2. 在 headless 中使用时，不要启用该 bundle，而是在自己的 patch 中挂载 `@deepseek-ai/dsh-terminal`、`@deepseek-ai/dsh-terminal-bash` 和 `@deepseek-ai/dsh-tool-terminal`。
3. 确认 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles` 中保留 `@deepseek-ai/dsh-experimental-terminal-bundle`，重启该 profile，再让 Agent 打开一个终端，侧栏中出现带 **Agent** 徽标的标签页，即说明迁移完成。
