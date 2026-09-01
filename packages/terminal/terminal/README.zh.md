---
description: "面向部署方与消费方的持久终端会话说明，用于选择、组合或扩展限定所有者范围的 ctx.terminals 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal

[English](README.md) | 中文

## 概述

`dsh-terminal` 为 harness 提供持久且限定所有者范围的终端会话：会话让 shell 或 REPL 状态跨工具调用存活，且每个操作都被限制在创建它的那个确切 agent（智能体）内。本包提供 `ctx.terminals` 服务，负责生成不透明的会话 id、通过已注册的后端路由会话创建，并在所有者或服务 dispose（资源释放）时等待完全停稳的清理。它本身不定义任何终端机制：`dsh-terminal-bash` 之类的后端负责启动与就绪检测，`dsh-tool-terminal` 中的面向模型工具负责呈现。会话只存在于进程本地：harness 重启后不会恢复。

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

当组合需要状态跨工具调用存活的终端会话时，挂载 `@deepseek-ai/dsh-terminal`。单独的服务本身没有用处：请与 `@deepseek-ai/dsh-terminal-bash` 之类的后端、`@deepseek-ai/dsh-tool-terminal` 之类的工具包配对，并在同一个组合中一起加载。

### 何时选择

当工作状态存在于终端而非文件时，选择持久终端：逐步调试 gdb、在 Python 或 Node REPL 中探索，或中断前台命令后回到 shell。对于有界操作，请选择单次 bash、read、write 与 edit 工具——它们保留更强的校验、审批、输出上限与回放约定。会话只存在于进程本地：harness 进程退出时它们会消失，因此需要持久的工作应写入文件或其他持久系统。

### 组合方式

将会话服务与后端、工具包一起加载：

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-terminal'
```

后端提供一个稳定类型——随附的 shell 后端提供 `shell`——工具按该类型打开会话。shell 后端还额外要求沙箱、沙箱策略与子进程提供方；完整组合见其 [README](../terminal-bash/README.zh.md)。

### 会话能做什么

会话存在后，消费方可以：打开会话并获得其 id 与有界启动输出；发送文本（可选地提交 Enter）并等待 shell 再次就绪或发送超时；读取有界保留输出；向前台进程组投递一个允许的信号；关闭会话并等待其进程树结束；以及列出调用方拥有的会话。每个会话同一时间最多有一个活跃发送；第二次发送会失败，直到第一次结算。

### 所有权与隔离

每个会话都由打开它的确切 agent 拥有。凡是指名会话的操作，只要调用方不是该 agent 就会被拒绝，因此即使模型获知另一个 agent 的 id，也无法操作其终端。可选的会话 `name` 是所有者本地的显示元数据——例如 `main` 或 `gdb` 这样的标签——并且只在所有者范围内唯一。

### 可观察结果与失败

成功打开会返回会话 id、类型、后端存在时的 pid、状态与有界启动消息。发送以等待原因结算：`stdin_read`（shell 正在等待输入）、`inferred_idle`（输出静默）、`timeout` 或 `session_exit`（顶层 shell 已退出）。失败携带稳定的机器可路由错误码：后端类型缺失（`NO_BACKEND`）、会话未知（`NO_SESSION`）、属于其他 agent 的会话（`FOREIGN_SESSION`）、并发第二次发送（`SEND_ACTIVE`），或所有者不再存活（`OWNER_NOT_LIVE`）。后端设置失败会在发布任何内容之前拒绝打开；清理失败会拒绝关闭，而不是声称成功。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

服务拥有终端机制以外的一切：会话身份、发布、授权与清理。后端负责会话如何启动、检测就绪、保留输出与关闭；服务只在后端设置成功后发布会话。这个拆分让同一个注册表可用于不同的终端基底。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `TerminalSessionService`：后端注册表、spawn/send/read/signal/kill/list、所有者清理与 dispose |
| [`src/types.ts`](src/types.ts) | 共享约定：后端接口、会话类型、等待原因、信号集合、错误码 |
| — | 不发布运行时不变式伴生入口；注册表是私有可变状态。 |

### 数据模型与生命周期

每个已发布会话是一条记录，包含其 id、所有者、可选名称、后端类型、后端会话，以及当前唯一的活跃发送。未发布的 spawn 按所有者以预留形式跟踪，并持有服务拥有的中止信号。dispose 会中止待完成的 spawn、等待其结算与回滚，然后关闭每个拥有的会话并等待完全停稳，最后运行所有者分离器；清理失败会拒绝生命周期，而不是声称成功。

### 所有权与清理规则

- 限制基于确切的 `Agent` 对象：`hasOwnerActivity(owner)` 覆盖从尚未发布的设置到最终关闭的全过程，没有发布竞态，因此生命周期策略可以精确限制所有者。
- 无法清理部分启动资源的后端会以 `TerminalBackendCleanupError` 拒绝；服务会将该失败保留为受跟踪的所有者活动，直到所有者或服务 dispose 消费并报告它。
- 调用方取消保留其确切的 `AbortSignal.reason`；`kill()` 与 dispose 只在后端捕获的进程树完全停稳后完成。

### 发送预留

服务在返回操作之前同步为一个活跃发送预留会话，包括在后台 job id 可见之前；第二次发送会以 `SEND_ACTIVE` 失败，因此输出与取消永远不会跨操作所有权。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享终端模型进入随附后端、工具与设计证据。

- [终端子系统参考](../../../docs/subsystems/terminal.zh.md)——共享类型、后端与会话约定，以及生成的 `ctx.terminals` 接口面。
- [terminal/ 包映射](../README.zh.md)——三包家族及其组合方式。
- [terminal-bash 后端](../terminal-bash/README.zh.md)——提供 `shell` 类型的随附 shell 后端。
- [tool-terminal 工具](../tool-terminal/README.zh.md)——操作会话的 6 个面向模型工具。
- [持久 PTY Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)——设计理由、备选方案与暂缓边界。

-----

<a id="model-experience"></a>
## 模型体验

### 间接消费方

#### 模型看到什么

没有直接可见内容。此包不注册提示词或工具；可见 schema 与结果文本由 `@deepseek-ai/dsh-tool-terminal` 负责。

#### Token 影响

没有直接影响。活跃会话状态保留在进程本地，直到消费方返回有界结果。

#### KV Cache 影响

不会直接失效；请求前缀变更由 `@deepseek-ai/dsh-tool-terminal` 负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明服务何时不合适。它们是当前包约束，不是任务积压。

- **进程本地会话**——会话与原始 scrollback 只存在于本进程中，harness 重启后不会恢复；需要持久的工作必须写入文件或其他持久系统。
- **不支持跨 agent 共享**——会话有意保持单一所有者，没有共享或转移会话的途径。
- **没有声明式自动启动**——会话只在 agent 工具调用期间创建。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性：已交付的行为、限制与既定理由以本文档上文、包代码与所链接的 Agent Note 为准。

#### 未决方向

- 共享会话设计需要独立的权限约定。
- 声明式自动启动功能需要通过尚未发布的 agent 设置组合而成。

</details>
