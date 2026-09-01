---
description: "面向需要跨调用终端状态的 agent 的 6 个持久终端工具，带所有者隔离、有界结果与可选后台发送。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-terminal

[English](README.md) | 中文

## 概述

`dsh-tool-terminal` 基于持久终端会话为模型提供 6 个工具：`terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close` 与 `terminal_list`。每次调用都被限制在打开该会话的那个确切 agent（智能体）内，因此即使模型获知另一个 agent 的 id，也无法操作其终端。发送可以前台运行（返回带等待原因的有界输出），也可以通过任务服务后台运行（返回 job id，用 `job_output` 收集、用 `job_kill` 停止）。结果受 `maxResultBytes` 限制，并保留在会话历史中直到压缩（compaction）。一段简短指引会告诉模型：除非确实需要终端的持久状态或交互式 stdin，否则优先使用单次工具。

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

当组合挂载了终端后端、且模型应当能跨调用使用终端状态时启用这些工具——逐步调试 gdb、在 REPL 中探索，或中断前台命令后回到 shell。指引章节会引导模型对确有界操作使用单次 bash、read、write 与 edit 工具。

### 六个工具

| 工具 | 作用 | 结果 |
|---|---|---|
| `terminal_open` | 按后端类型创建限定所有者范围的会话 | 会话 id、名称、类型、pid、状态与有界启动输出 |
| `terminal_send` | 写入文本，可选地提交 Enter，并等待就绪——或启动后台任务 | 有界输出加等待与会话状态，或一个 job id |
| `terminal_read` | 不发送输入，读取一页有界保留输出 | 带行分页元数据的文本 |
| `terminal_signal` | 向前台进程组投递一个允许的信号 | `delivered` 加目标进程组 id |
| `terminal_close` | 关闭会话并等待其进程树结束 | 已关闭或正在关闭的结果 |
| `terminal_list` | 列出调用方的活跃会话 | 限定所有者范围的会话摘要 |

### 组合方式

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-terminal'
```

工具需要 `ctx.terminals`——必须挂载一个后端——以及用于指引章节的系统提示词服务。后台发送还额外要求任务服务及其面向模型的控制器（`@deepseek-ai/dsh-tool-jobs`）。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enableRunInBackground` | `true` | 公开并接受 `run_in_background`；设为 `false` 时移除 schema 字段并拒绝该参数 |
| `maxResultBytes` | `262144` | 每个完整终端结果的 UTF-8 上限（最小值 `64`）；在等待、会话、分页、截断与任务状态元数据全部加入后计算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-terminal)与[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-terminal)是配置字段与 schema 的穷尽式真源。

### 后台发送

`terminal_send(run_in_background: true)` 立即返回 job id，而不是等待。任务用 `job_output` 收集——它会等待并读取增量输出——用 `job_kill` 停止，后者向前台进程组投递真正的 `SIGINT`。缺少任务接口面时，后台模式会在写入输入之前失败。

### 可观察结果与失败

前台发送返回终端的新输出以及 `wait: <原因>` 与会话状态；`session_exit` 表示顶层 shell 已退出，而 `inferred_idle` 或 `timeout` 绝不证明前台命令已退出。用未注册的后端类型打开会话会失败。大于 `maxResultBytes` 的结果会在 UTF-8 边界处截断并附标记。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本包是薄适配层：6 个工具以执行 agent 作为所有者转发到 `ctx.terminals`，呈现层渲染有界结果。后台发送把在途操作注册到 `ctx.jobs`，由通用任务接口面负责等待、增量读取与 `SIGINT` 投递。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 6 个工具定义、schema、指引章节、后台任务集成 |
| [`src/render.ts`](src/render.ts) | 结果渲染与完整结果的 UTF-8 上限 |

### 结果上限

每个终端自身的单文本结果都会在规范化后的工具或流水线错误、策略拒绝与短路、替换与阻止、以及通用任务状态文本之后，受 `maxResultBytes` 限制；截断保留 UTF-8 边界并为截断标记预留空间。结构化的多块策略结果保留其结构。64 字节的最小上限保证注册表签发的每个会话或 job id 都出现在创建确认中。

### UI 呈现意图

前台发送使用终端调用与结果卡片；后台发送与其他 5 个工具使用通用 `execute`、`read` 或 `delete` 卡片。所有工具都不输出源位置。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从生成的 schema 进入服务约定、后端与后台任务接口面。

- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-terminal)——6 个生成的 schema 与结果形态。
- [终端子系统参考](../../../docs/subsystems/terminal.zh.md)——工具背后的服务约定与共享类型。
- [terminal 服务](../terminal/README.zh.md)——会话操作、所有者限制与清理语义。
- [terminal-bash 后端](../terminal-bash/README.zh.md)——提供会话的随附 shell 后端。
- [jobs 包映射](../../jobs/README.zh.md)——收集与停止后台发送的后台任务接口面。
- [持久 PTY Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)——能力设计与暂缓边界。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

该插件贡献以下固定指引章节：

##### 终端指引

```markdown
Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.
```

#### Token 影响

插件活跃期间，每次请求都会产生少量固定输入成本。

#### KV Cache 影响

注册范围与指引文本不变时，前缀保持稳定。

### 工具 schema

#### 模型看到什么

6 个生成的 schema 列在 [`dsh-tool-terminal` 目录章节](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-terminal)中。此插件活跃时，请求中会包含它们的固定 schema token；按 agent 范围过滤工具时可能隐藏这些 schema。

#### Token 影响

工具可见的请求会产生固定的 schema 成本。

#### KV Cache 影响

工具可见性与定义不变时，前缀保持稳定。

### 工具结果与任务上下文

#### 模型看到什么

spawn 返回 id 与有界启动输出。发送与读取返回有界终端文本以及就绪与历史标记。后台模式返回通用 job id。每个终端自身的单文本结果都受 `maxResultBytes` 限制；结果保留在会话历史中直到压缩，增量任务读取不会重复已经消费的输出。

#### Token 影响

终端自身的结果随数据变化，并受 `maxResultBytes` 限制；每个返回结果都保留在历史中直到压缩。

#### KV Cache 影响

仅追加；新结果位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明缺失的面向模型接口面。它们是当前包约束，不是任务积压。

- **没有 TUI 或按键序列接口面**——具名按键序列、全屏 TUI 交互、BEL、调整大小与自动启动均未出现在任何 schema 中。
- **后台模式要求任务接口面**——`run_in_background` 同时需要 `@deepseek-ai/dsh-jobs` 及其面向模型的控制器（`@deepseek-ai/dsh-tool-jobs`）；缺少时会拒绝该参数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个无状态 adapter 只贡献 tool 与 prompt guidance；PTY lifecycle 与 background-job 关系属于其组合的 service。
