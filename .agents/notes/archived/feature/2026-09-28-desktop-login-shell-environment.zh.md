# Agent Note: Desktop 一次性读取登录 shell 环境

Status: implemented
Archived: 2026-09-30

[English](2026-09-28-desktop-login-shell-environment.md) | 中文

## 问题

从 macOS 的 Dock、Finder 或 Linux 桌面启动 Desktop 时，它只获得会话管理器提供的环境。用户在 `~/.zprofile` 或 `~/.zshrc` 中导出的变量，包括 Homebrew、版本管理器的 PATH 条目和 API key，在 Host、agent shell、终端和 profile 配置中都不存在。从终端启动同一个 Host 时这些变量都在。

## 决策

创建第一个 Host 之前，[Desktop](../../../../apps/desktop/README.zh.md) 通过 `<shell> -ilc` 运行一次带定界符的 `env -0` 输出，`<shell>` 依次为账户记录中的登录 shell、`/bin/zsh`、`/bin/bash` 和 `/bin/sh`。同一应用进程中的所有 Host 使用合并后的结果。shell 的值覆盖继承的值，但读取进程自身的会话变量以及 `DSH_*` 和 `ELECTRON_*` 命名空间除外。读取在结束定界符出现时完成。超时或退出会结束读取进程组；读取失败时回退到继承的环境，不阻止启动。Windows 跳过读取。

## 考虑过的替代方案

**读取 `$SHELL` 而不是账户记录。** 从 Dock 启动时，`$SHELL` 继承自 launchd，而不是用户当前的选择；从终端启动时它可能是临时 shell。账户记录给出用户用 `chsh` 选择的 shell。

**只使用非交互的 `-lc`。** 多数用户在 `~/.zshrc` 中添加 PATH，而只有交互式 shell 会读取它。交互模式需要设置读取变量，避免 oh-my-zsh 更新提示和 tmux 自动启动阻塞。

**允许 shell 的值覆盖 `DSH_*` 变量。** Desktop 在读取之前已解析 `DSH_HOME` 及其 profile 路径，因此 `~/.zshrc` 导出的 `DSH_HOME` 会让 Host 使用与 Desktop 已准备的不同的 home。

**等待 stdout 关闭。** 启动文件启动的后台进程继承 stdout，可能无限期保持它打开，使每次读取都超时。

## 影响

从 Dock 和 Finder 启动时，Host 获得与从终端启动相同的环境。修改启动文件后需要重启 Desktop 才生效。启动需要等待读取，每个候选最多 `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS`。无法运行 POSIX 输出命令的账户 shell（如 csh、tcsh 和 nushell）改为获得第一个系统 shell 的环境。`DSH_*` 设置必须来自启动方的环境，而不是启动文件。单元测试用替身 shell 覆盖提前完成、超时、中止和回退路径，Desktop 启动测试验证 Host 等待读取完成。
