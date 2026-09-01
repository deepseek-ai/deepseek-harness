---
description: "面向模型的持久 bash 工具，供选择、配置或排查跨调用保留的按所有者隔离 shell 状态的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-bash-persistent

[English](README.md) | 中文

## 概述

`dsh-tool-bash-persistent` 为 agent 提供 `bash` 工具，其 shell 状态对拥有它的 agent 跨调用保留：cwd、导出的变量、函数与后台任务都会在命令之间存活。每个 agent 都有自己由 terminal 服务的按所有者隔离 PTY 会话支撑的 shell，同一 agent 的命令逐个串行执行。配置选择 PTY 后端与单条命令的墙钟上限；超时或显式 `exit` 会关闭 shell，下一次调用从全新状态开始。它补充一次性 `dsh-tool-bash` 工具——当工作依赖跨调用状态时选择它。请与 `dsh-terminal-bash` 等 terminal 后端以及 `ctx.terminals` 服务一起挂载。

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

在 agent 需要在命令之间保持 shell 状态的任何组合中加载本插件——例如长时间构建会话、已激活的环境，或为后续步骤导出变量的脚本。它注册 `bash` 工具，需要 `ctx.tools` 与 `ctx.terminals` 服务，并在执行时需要拥有者 agent 会话。

### 何时选择

当工作依赖跨调用状态时选择持久工具：一次性 `dsh-tool-bash` 调用无法记住 `cd` 或导出的变量。当每条命令都应从已知、干净的环境开始，或命令又短又独立时，选择一次性工具。这里不支持需要交互 stdin 的命令——读取输入的前台子进程会一直阻塞到命令超时——因此交互工作属于 terminal 工具。

### 最小配置

默认的 `shell` 后端通过 `dsh-terminal-bash` 启动交互式 bash；部署方可以注册其他 PTY 后端并按名称选择。

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-bash-persistent'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backendType` | `shell` | 用于每个 agent shell 的已注册 PTY 后端 |
| `timeoutMs` | `300,000` | 单条命令的墙钟上限；超时关闭 shell |
| `maxOutputChars` | `16,000` | 保留的命令输出字符上限；固定诊断信息在其后追加 |
| `description` | `Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.` | 面向模型的环境约定；部署方可描述自己的环境 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-bash-persistent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### agent 可以依赖什么

命令共享每个 agent 一个 shell，因此状态一直保留到 `exit`、超时或重置——每一种都会关闭 shell 并告诉 agent 下一次调用从工作区的新目录与环境开始。结果排除私有完成标记；非零的包装命令追加 `[exit code: N]`，而在报告该状态前就退出的 shell 改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]` 或 `[shell exited]`，然后重置。长输出保留最早的已保留前缀并附裁剪通知；若 terminal 已经丢弃该前缀，结果会明确说明，而不是把尾部当作完整输出呈现。

### 可能出什么问题

没有拥有者 agent 会话的调用会以 `bash requires an owning agent session` 失败，没有 PTY 后端的组合会激活该工具，但首次调用以 `no PTY backend registered for "shell"` 失败。交互式前台子进程（例如 REPL）只有在后端证明其 stdin 等待时才提前返回部分输出；否则调用一直运行到 `timeoutMs`，随后关闭不确定的 shell 并报告重置。取消也会重置并丢弃结果，即使完整状态标记已经可观察。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **每个 owner 一个 shell，互不共享。** shell 注册表按调用方 `Agent` 为每个会话建键，因此并发 agent 永不共享状态，同一 agent 的命令通过按 owner 的队列串行化。
- **标记锚定提取。** 每条命令都用携带退出状态的唯一起止标记包装；工具轮询 PTY scrollback 并提取真实标记之间的区间，因此提示词与回显输入永不泄漏进结果。
- **重置，而非修复。** 任何不确定状态——显式 `exit`、超时、发送失败、中止——都会关闭 shell 并让下一次调用从全新状态开始，因为半知情的 shell 不如干净的 shell。
- **按 owner 的生命周期。** shell 在首次使用时惰性创建，在插件释放或 owner 拆除时终止；按所有者隔离的 `ctx.terminals` 服务把每个操作都围栏到拥有它的 agent。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：shell 注册表、命令包装、scrollback 轮询、提取与渲染 |
| — | 不发布运行时不变式伴生入口；shell 复用可通过工具执行观察。 |

### 命令流程

首条命令通过 `ctx.terminals.spawn` 生成 shell，禁用输入回显（`stty -echo`），并等待就绪。随后每条命令都包装成一行物理文本——printf 起始标记、用 `$'…'` 转义的命令体、printf 结束标记加 `$?`——因此内嵌换行无法把终端提示词泄漏进结果。工具以 1,000 行一页轮询 scrollback，直到出现结束标记，提取区间并连同任何状态标记一起渲染。超时会中止截止时间、捕获部分输出并重置 shell。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 terminal 家族逐步进入 seam、后端，以及按所有者会话背后的设计笔记。

- [terminal 包映射](../../terminal/README.zh.md)——持久 PTY 能力家族。
- [terminal seam](../../terminal/terminal/README.zh.md)——工具背后的 `ctx.terminals` 服务。
- [terminal-bash 后端](../../terminal/terminal-bash/README.zh.md)——默认的 `shell` 后端。
- [tool-terminal](../../terminal/tool-terminal/README.zh.md)——面向交互工作的六个模型侧 terminal 工具。
- [持久 PTY 会话 Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)——按所有者会话的设计及其理由。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bash-persistent)——`bash` 参数 schema 的确切内容。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-bash-persistent)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

生成的 [`bash` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bash-persistent)，包括配置的 `description`。本插件不贡献独立的系统提示词区段；人设与环境指引由部署方负责。

#### Token 影响

`bash` 可见期间产生固定 schema 开销。

#### KV Cache 影响

只要配置的描述与 schema 不变，前缀就保持稳定。

### 工具结果

#### 模型看到什么

命令共享每个 Agent 一个 shell，因此 cwd、导出的变量、已激活的环境、函数与后台任务都会跨调用保留。结果排除私有完成标记。当 shell 在没有打印完成标记的情况下再次读取 stdin——`exec`、中断，或提供方证明其 stdin 等待的交互式前台子进程之后——调用返回捕获的部分输出，它可能以后端自己的提示词文本结尾。非零的包装命令追加 `[exit code: N]`；在报告该状态前就退出的 shell 改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]`，或后端两者都未提供时的 `[shell exited]`，然后重置并告诉模型下一次调用从全新状态开始。长输出保留最早的已保留前缀并附裁剪通知。若 PTY 已经丢弃该前缀，结果会明确说明，而不是把尾部当作完整输出呈现。超时返回有界部分输出、关闭不确定的 shell 并报告重置。

#### Token 影响

依数据而定。`maxOutputChars` 限制保留的命令输出；固定的裁剪、丢失前缀、状态、超时与重置诊断可能延长结果。

#### KV Cache 影响

仅追加的工具结果位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适或需要特别小心。它们是当前包约束，不是任务积压。

- **工具需要拥有者 Agent 与真实的 PTY 后端**——无 agent 的调用与无法启动交互 shell 的后端都会失败。
- **交互式前台子进程只在子进程提供方证明其 stdin 等待时才提前返回部分输出**——否则调用一直运行到 `timeoutMs`。
- **显式 `exit` 与超时会丢弃 shell 状态**——取消同样重置并丢弃结果，即使完整状态标记已经可观察；下一次调用启动全新 shell。
- **网络访问与包镜像等环境事实属于配置的 `description`**——而不是本包的默认描述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
