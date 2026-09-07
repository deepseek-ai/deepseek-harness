---
description: "面向模型的持久 pwsh 工具，供选择、配置或排查跨调用保留的按所有者隔离 PowerShell 状态的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-pwsh-persistent

[English](README.md) | 中文

## 概述

`dsh-tool-pwsh-persistent` 为 agent 提供 `pwsh` 工具，其 PowerShell 状态对拥有它的 agent 跨调用保留：cwd、`$env:` 变量、函数与后台任务都会在命令之间存活。它是 `dsh-tool-bash-persistent` 的 Windows 对应物——相同的持久状态契约，PowerShell 方言。每个 agent 都有自己由按所有者隔离、带 pwsh 方言后端的 PTY 会话支撑的 shell，同一 agent 的命令逐个串行执行。配置选择后端与单条命令的墙钟上限；超时或显式 `exit` 会关闭 shell，下一次调用从全新状态开始。请与 pwsh 方言 terminal 后端（Windows ConPTY 或 POSIX pwsh）以及 `ctx.terminals` 服务一起挂载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 agent 需要在命令之间保持 PowerShell 状态的任何组合中加载本插件——它是 `dsh-tool-pwsh` 的持久对应物，用于依赖跨调用状态的工作。它注册 `pwsh` 工具，需要 `ctx.tools` 与 `ctx.terminals` 服务，并在执行时需要拥有者 agent 会话。

### 何时选择

当工作依赖跨调用 PowerShell 状态时选择持久工具；当每条命令都应从已知、干净的环境开始时选择 `dsh-tool-pwsh`。这里不支持需要交互 stdin 的命令——读取输入的前台子进程会一直阻塞到命令超时，随后重置 shell——因此交互工作属于 terminal 工具。

### 最小配置

默认的 `shell` 后端通过配置了 `shellDialect: pwsh` 的 `dsh-terminal-bash` 实例启动 PowerShell shell；部署方可以注册其他 pwsh 方言 PTY 后端并按名称选择。

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellDialect: pwsh
- name: '@deepseek-ai/dsh-tool-pwsh-persistent'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backendType` | `shell` | 用于每个 agent shell 的已注册 PTY 后端 |
| `timeoutMs` | `300,000` | 单条命令的墙钟上限；超时关闭 shell |
| `maxOutputChars` | `16,000` | 保留的命令输出字符上限；固定诊断信息在其后追加 |
| `description` | `Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent.` | 面向模型的环境约定；部署方可描述自己的环境 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### agent 可以依赖什么

命令共享每个 agent 一个 shell，因此 cwd、`$env:` 变量、函数与后台任务都会跨调用保留。结果排除私有完成标记、shell 提示词与回显的输入行。非零的包装命令追加 `[exit code: N]`——命令运行原生程序时给出确切原生退出码，PowerShell 终止错误则为 `1`。在报告该状态前就退出的 shell 改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]` 或 `[shell exited]`（Windows 强制终止报告 exit 1 且没有信号），然后重置并告诉 agent 下一次调用从全新状态开始。长输出保留最早的已保留前缀并附裁剪通知；若 terminal 已经丢弃该前缀，结果会明确说明。

### 可能出什么问题

没有拥有者 agent 会话的调用会以 `pwsh requires an owning agent session` 失败，没有 pwsh 方言 PTY 后端的组合会激活该工具，但首次调用以 `no PTY backend registered for "shell"` 失败。模型重定义 `prompt` 函数会移除就绪标记，shell 随后在静默层级而非标记快路径上结算。命令内的原始 ESC 字符会在执行前被 PSReadLine 消费，不受支持。超时或取消会关闭不确定的 shell、丢弃结果并报告重置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **`dsh-tool-bash-persistent` 的刻意孪生。** 会话注册表、轮询循环与重置约定按设计镜像持久 bash 工具（[pwsh 持久 PTY Agent Note](../../../.agents/notes/archived/architecture/2026-08-11-pwsh-persistent-pty.md)）。
- **prompt 函数就绪。** 工具安装自己的 `prompt` 函数，打印 BEL 结尾的 OSC 标记加可打印提示词；OSC 标记携带最后的退出码，可打印提示词让每条命令都能结算，因此模型重定义 `prompt` 会把就绪降级到静默层级。
- **PSReadLine 回显靠锚定剥离。** PowerShell 会把提交的输入渲染回流中；标记锚定提取与包装源码剥离移除回显，而跨终端宽度换行的包装可能在部分输出结果中留下部分回显。
- **重置，而非修复。** 任何不确定状态——显式 `exit`、超时、发送失败、中止——都会关闭 shell 并让下一次调用从全新状态开始。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：shell 注册表、prompt 设置、命令包装、scrollback 轮询、提取与渲染 |
| — | 不发布运行时不变式伴生入口；shell 复用可通过工具执行观察。 |

### 命令流程

首条命令通过 `ctx.terminals.spawn` 生成 shell，安装 `prompt` 覆盖，并等待就绪。随后每条命令都包装成一行物理文本——`Write-Output` 起始标记、用反引号转义进双引号字符串的命令体、`Write-Output` 结束标记加退出状态——因此 PSReadLine 对换行包装的回显无法伪造完成。工具以 1,000 行一页轮询 scrollback，直到出现结束标记或完成的提示词，提取区间、剥离回显的包装与提示词，并连同任何状态标记一起渲染。超时会中止截止时间、捕获部分输出并重置 shell。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 terminal 家族逐步进入 seam、后端，以及持久 shell 设计背后的设计笔记。

- [terminal 包映射](../../terminal/README.zh.md)——持久 PTY 能力家族。
- [terminal seam](../../terminal/terminal/README.zh.md)——工具背后的 `ctx.terminals` 服务。
- [terminal-bash 后端](../../terminal/terminal-bash/README.zh.md)——默认后端，配置 `shellDialect: pwsh`。
- [pwsh 持久 PTY Agent Note](../../../.agents/notes/archived/architecture/2026-08-11-pwsh-persistent-pty.md)——pwsh 侧会话设计及其理由。
- [持久 PTY 会话 Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)——按所有者会话的设计及其理由。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)——`pwsh` 参数 schema 的确切内容。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

生成的 [`pwsh` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh-persistent)，包括配置的 `description`。本插件不贡献独立的系统提示词区段；人设与环境指引由部署方负责。

#### Token 影响

`pwsh` 可见期间产生固定 schema 开销。

#### KV Cache 影响

只要配置的描述与 schema 不变，前缀就保持稳定。

### 工具结果

#### 模型看到什么

命令共享每个 Agent 一个 shell，因此 cwd、`$env:` 变量、函数与后台任务都会跨调用保留。结果排除私有完成标记、shell 提示词与回显的输入行（PSReadLine 会把提交的输入渲染回流中；标记锚定提取与包装源码剥离会移除它）。非零的包装命令追加 `[exit code: N]`——命令运行原生程序时给出确切原生退出码，PowerShell 终止错误则为 `1`。在报告该状态前就退出的 shell 改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]`，或后端两者都未提供时的 `[shell exited]`（Windows 强制终止报告 exit 1 且没有信号），然后重置并告诉模型下一次调用从全新状态开始。长输出保留最早的已保留前缀并附裁剪通知；若 terminal 已经丢弃该前缀，结果会明确说明。超时返回有界部分输出、关闭不确定的 shell 并报告重置。

#### Token 影响

依数据而定。`maxOutputChars` 限制保留的命令输出；固定的裁剪、丢失前缀、状态、超时与重置诊断可能延长结果。

#### KV Cache 影响

仅追加的工具结果位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适或需要特别小心。它们是当前包约束，不是任务积压。

- **工具需要拥有者 Agent 与带 pwsh 方言的真实 terminal 后端**——Windows ConPTY 或 POSIX pwsh。
- **输入回显不可避免**——PowerShell 的 PSReadLine 会把提交的输入渲染回终端流，而且没有 `stty -echo` 等价物。标记锚定提取在完整结果中排除回显；包装源码剥离覆盖回退路径，但跨终端宽度换行的包装可能在部分输出结果中留下部分回显，受 `maxOutputChars` 设界。
- **模型命令内的原始 ESC 字符不受支持**——PSReadLine 会在执行前消费它们。包装器会转义它需要的控制字节（`[char]27` 构造的 OSC 标记、正文的反引号转义）。
- **模型重定义 `prompt` 函数会移除就绪标记**——shell 随后在静默层级而非标记快路径上结算。
- **命令期间没有交互 stdin**——读取输入的前台命令会一直阻塞到命令超时，随后重置 shell。
- **Windows 上 SIGTSTP/SIGHUP 不可用**（后端拒绝）；SIGINT 以控制台级 Ctrl-C 输入写入投递，在提示词处会取消待处理行而不是向进程发信号。
- **在 Windows ACL 沙箱的只读模式下，pwsh 以 ConstrainedLanguage 启动**，可能拒绝引导的 `[Console]::` 编码固定与 prompt 标记。命令仍可通过可打印提示词与静默层级结算，但非 ASCII 输出可能跟随宿主代码页。
- **BEL 结尾的 OSC 标记目前只是就绪信号**——通向模型的 BEL 事件通道仍被推迟，与当前实现保持一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
