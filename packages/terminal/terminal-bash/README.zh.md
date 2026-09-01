---
description: "持久终端会话的随附 shell 后端：在共享沙箱策略下启动交互式 bash 或 pwsh，带就绪检测与有界逐行输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal-bash

[English](README.md) | 中文

## 概述

`dsh-terminal-bash` 在部署的沙箱策略下启动持久交互式 shell：会话跨工具调用存活，检测 shell 何时可以接收输入，并保留有界的逐行输出供读取。它提供 `shell` 后端类型，并通过 `shellDialect` 设置在 POSIX 上支持 bash、在 Windows 上支持 pwsh。通过已挂载的子进程提供方，同一个后端既可以与本地执行世界组合，也可以与远程执行世界组合。全屏终端应用不在其逐行约定的范围内。

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

当组合需要持久 shell 会话时挂载此后端——cwd、导出的变量、函数或正在运行的交互式子进程等状态必须跨工具调用存活。它是默认的 `shell` 类型：组合只挂载 `@deepseek-ai/dsh-terminal` 而不挂载它时，将没有任何会话可打开。

### 何时选择

当工作需要状态持续存在的交互式 shell 或 REPL 时选择此后端：逐步调试 gdb、在 Python 或 Node REPL 中探索，或中断前台命令后回到 shell。对于应当一次调用即开始并结束的有界命令，请选择单次 bash 工具。bash 方言面向 POSIX；pwsh 方言面向 `dsh-pwsh-local` 能解析出 pwsh 可执行文件的 Windows 主机。

### 组合方式

挂载终端服务、子进程提供方、沙箱与策略服务、此后端以及一个工具包：

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-sandbox-local'
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-terminal'
```

`danger-full-access` 直接启动 shell。受限模式要求同一执行世界中存在 `ctx.sandbox` 提供方：缺少时，spawn 会在 shell 启动前失败。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backendType` | `shell` | 注册到 `ctx.terminals` 的后端类型 |
| `shellDialect` | `bash` | 交互式 shell 栈：`bash` 或 `pwsh` |
| `shellPath` / `shellArgs` | 按方言 | shell 可执行文件与参数；为空时选择方言默认值 |
| `maxReadBytes` | `262144` | 一次读取或一次结算发送返回的最大 UTF-8 字节数 |
| `timeoutMs` | `30000` | 一次发送等待的绝对上限 |
| `disposeGraceMs` | `3000` | 清理升级到 `SIGKILL` 前的宽限时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-terminal-bash)是每个字段的穷尽式真源，包括就绪计时（`pollIntervalMs`、`exactProbeAfterMs`、`idleSilenceMs`、`handoffGraceMs`）、终端尺寸（`rows`、`cols`）与 scrollback 上限（`scrollbackLines`、`scrollbackMaxBytes`）。

### shell 方言与就绪

两种方言暴露相同的就绪约定，因此消费方与方言无关。当 shell 再次就绪时发送即结算：受控提示符被验证之后、前台进程组被证明在等待 stdin（Linux）之后、输出静默（`inferred_idle`）之后，或到达绝对 `timeoutMs`。`inferred_idle` 或 `timeout` 结果并不证明前台命令已退出。

### 沙箱与安全运行

shell 在整个生命周期内运行在有效的沙箱边界之下。当所有者仍有打开的会话或进行中的 spawn 时，改变有效沙箱模式会被拒绝——请先等待创建完成并关闭会话，避免以更宽权限打开的终端在权限降级后继续存在。后端只提供终端专属的环境覆盖；共享凭据清理由子进程提供方负责。

### 可观察结果与失败

打开会返回会话 id 与有界启动消息。发送以四种等待原因之一与一个会话状态结算；`session_exit` 表示顶层 shell 已退出。设置失败会拒绝打开：受限模式下缺少沙箱提供方、shell 在启动期间退出、shell 未能在启动超时前达到就绪，或调用方取消。清理失败会拒绝关闭，而不是声称成功。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

一个后端服务两种方言：bash 与 pwsh 共享同一套会话机制——清理器、有界缓冲区、就绪轮询、取消与关闭——只在 argv、环境与提示符安装方式上不同。bash 通过 `PS1` 加 `PROMPT_COMMAND` 接收私有标记。pwsh 会写入提示符函数、钉住 UTF-8 控制台编码，并只在后端报告 `stdin_read` 后发布启动；回显的设置文本不能发布 shell。一个不保留 scrollback 的 `@xterm/headless` 实例会消费原始 PTY 数据，并通过同一句柄返回终端协议响应；逐行 sanitizer 仍是唯一输出投影。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 后端注册、沙箱模式限制、argv 与环境组装、启动序列 |
| [`src/config.ts`](src/config.ts) | 方言解析、默认值与每个计时字段的校验 |
| [`src/session.ts`](src/session.ts) | `LocalPtySession`：发送生命周期、就绪轮询、scrollback、信号、关闭 |
| [`src/sanitize.ts`](src/sanitize.ts) | 流式控制序列清理器与行规范化 |

### 就绪模型

三个有界档位结算一次发送：来自子进程提供方的精确 stdin 等待证据（仅 Linux）、带精确可打印尾部的受控私有提示符标记，以及输出静默（`inferred_idle`）；绝对超时始终限制等待。pwsh 启动的完整设置循环共用一条 deadline，因此 `inferred_idle` 后续发送不会重新计时。提供方写入前收集的证据会在写入边界丢弃，早于写入的 stdin 等待不算写入后就绪，未知的前台状态绝不是精确空闲的正向信号。

### 发送取消与关闭

取消先把排队输入标记为已取消，再在任何在途的提供方写入结算后向当前前台进程组发送真正的 `SIGINT`；它绝不会通过写入 `\x03` 模拟中断。关闭会停止就绪轮询、终止提供方拥有的进程树、等待完全停稳，并把活跃发送结算为 `session_exit`。

### 沙箱模式限制

当所有者存在打开的会话或进行中的 spawn 时，凡是会改变有效沙箱模式的写入都会在 `sandbox/mode` 事件提交前被拒绝。该限制绑定到确切所有者，并在保留现有会话的提供方重新加载后依然有效。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享终端模型进入服务、工具与执行世界基底。

- [终端子系统参考](../../../docs/subsystems/terminal.zh.md)——此后端实现的服务器约定与生成的 `ctx.terminals` 接口面。
- [terminal 服务](../terminal/README.zh.md)——后端注册、所有者限制与清理语义。
- [tool-terminal 工具](../tool-terminal/README.zh.md)——操作会话的面向模型工具。
- [子进程 seam](../../../docs/subsystems/subprocess.zh.md)——负责 PTY 分配与进程树清理的终端原语。
- [持久 PTY Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)——能力设计与暂缓边界。
- [持久 pwsh Agent Note](../../../.agents/notes/implemented/architecture/2026-08-11-pwsh-persistent-pty.zh.md)——Windows 基底与 pwsh 方言。

-----

<a id="model-experience"></a>
## 模型体验

### 间接消费方

#### 模型看到什么

此包不注册提示词或工具。模型通过 `@deepseek-ai/dsh-tool-terminal` 或其他 PTY 消费方可能收到有界的启动输出、发送增量、scrollback 页、就绪原因与清理错误。

#### Token 影响

在消费方返回有界输出之前，保留的 PTY scrollback 不会进入模型历史。

#### KV Cache 影响

不会直接失效；消费方结果保持仅追加。

### 沙箱策略上下文

#### 模型看到什么

组合此后端期间，`sandbox-policy` 归属方会向提示词贡献与具体能力无关的 `sandbox:policy` 运行时上下文子句。

#### Token 影响

后端挂载期间，请求中会包含该策略子句。

#### KV Cache 影响

常驻策略发生变化时，会在保留的历史之后追加一份取代先前状态的运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明后端何时不合适或需要特别的运维注意。它们是当前包约束，不是通用 shell 对比或任务积压。

- **仅逐行输出**——headless xterm 只为终端协议响应维护控制序列状态。返回输出仍按行规范化；不支持全屏备用缓冲区交互。
- **没有精确档时，就绪是启发式的**——精确 stdin 等待检测取决于已挂载的子进程提供方；无法证明该状态的提供方（macOS、Windows）按提示符标记与静默／超时就绪结算。
- **受限沙箱中的 pwsh 引导**——提示符函数与 UTF-8 钉通过 `[Console]::` 写入，Windows ACL 沙箱的只读模式可能拒绝。若因此无法获得 marker 就绪，启动会在 `timeoutMs` 到期时拒绝，而不会发布不完整的 shell。
- **清理保证属于提供方**——进程树清理是 `SubprocessTerminalHandle` 的约定，而不是此后端的。
- **会话不随进程退出存活**——harness 重启会销毁所有会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。readiness、terminal buffer 与 process-tree state 都是按 Session 的私有实现状态，backend 不发布独立 lifecycle stream 或 snapshot。
