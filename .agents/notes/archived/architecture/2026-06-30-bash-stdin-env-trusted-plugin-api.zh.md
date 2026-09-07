# Agent Note: 在 bash seam 上支持 stdin 与额外 env

Status: implemented
Archived: 2026-09-04

[English](2026-06-30-bash-stdin-env-trusted-plugin-api.md) | 中文

## 问题

钩子子系统以 Claude Code 和 Codex 的方式运行外部钩子命令：钩子是一条 shell 命令，通过 **stdin 上的 JSON** 接收事件载荷，并从若干**环境变量**（`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT`、`PLUGIN_ROOT`……）读取上下文。harness 已经在 `ctx.shell` 能力 seam 后面有一个完善的命令执行器（[dsh-shell](../../../../packages/shell/shell) → [dsh-bash-local](../../../../packages/shell/bash-local)），具备进程组终止、输出截断/spill 处理和凭证擦除功能。复用它来执行钩子意味着钩子桥接层无需重新实现子进程底层机制——但该 seam 此前无法写入 stdin 或设置额外 env。本次变更添加这两个输入。

`stdin` 和 `env` 不构成新的模型能力，因为普通 shell 语法已经能提供两者。环境凭证由 `dsh-bash-local` 的子环境擦除机制保护，而非靠隐藏这些 Service Definition 字段；模型工具参数是静态 JSON，不会展开 shell 变量。因此这些字段服务于受信的进程内调用方（如钩子桥接层），它们需要传递结构化输入和 `CLAUDE_*` 变量，而不必将其嵌入模型可见的 shell 文本。环境变量规则见 [defensive-patterns.md](../../../../docs/defensive-patterns.zh.md)。

## 决策

在 `ShellExecRequest`（模型/插件侧请求）和 `ShellExecSpec`（`run`/`start` 所作用的已解析 spec）上**同时**添加 `stdin?: string` 与 `env?: Record<string, string>`，并在 `dsh-bash-local` 中贯穿它们：`resolve()` 原样传递，`run()`/`start()` 将其传给 `runBash`，后者把字节写入子进程的 stdin 并合并额外 env。

三个有意为之的选择：

1. **模型侧工具不暴露 `stdin` 和 `env`。** Shell 语法已覆盖这些需求，重复参数只会增加接口面而不带来权限隔离。工具仅从声明的模型参数、signal 和 owner 构建请求；受信的进程内调用方可以直接设置请求字段。harness 自有变量使用[托管环境决策](../feature/2026-07-10-agent-session-identity-and-log-location.zh.md)规定的独立 `dshEnv` 通道，因此普通 `env` 无法替换它们。

2. **`env` 在凭证擦除之后合并，因此调用方显式设置的条目即使具有凭证形态的名称也会胜出。** 后续的托管命名空间决策负责管理 `DSH_*`：这类环境条目会被移除，受信的 `dshEnv` 最后合并，因此普通 `env` 条目永远无法顶掉托管值。完整顺序为 `scrub(process.env, including DSH_*)` → `ENV_OVERRIDES` → 普通 `env` → `dshEnv`。

3. **`stdin`/`env` 在已解析 spec 上是 required-absent-OK（普通 optional），而非像 `owner` 那样 required-but-nullable。** `owner` 之所以是 required-but-nullable，是因为*静默*缺失的 owner 会产生一个无主、跨会话可读的任务——一个安全隐患，显式的 `undefined` 可以防范。`stdin`/`env` 没有这种风险：缺失意味着「无 stdin / 无额外 env」，这是安全的常规情况（所有模型驱动的调用都如此）。因此它们保持普通 optional，与 `signal` 一致。

`dsh-bash-local` 仅在有字节需要写入时才创建 stdin 管道；否则 fd 0 仍为 `/dev/null`，保持先前行为。它写入字节后关闭管道。子进程未读取即退出时产生的 `EPIPE` 被忽略，因为命令退出码和输出决定结果。

## 曾考虑的替代方案

**可配置的环境秘密擦除。** 否决，属于推测性需求。受信调用方可以在擦除之后显式提供所需值，无需削弱默认的环境保护。

## 后果

钩子桥接层通过既有的 bash seam 传递 JSON 载荷和钩子特定变量，保留其进程组终止、截断和 spill 行为。面向模型的行为不变，bash 工具仍是模型调用请求构建的唯一所有者。相关词汇定义见 [bash 数据结构参考](../../../../docs/subsystems/shell.zh.md)。
