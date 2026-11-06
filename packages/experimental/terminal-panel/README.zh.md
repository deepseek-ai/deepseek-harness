---
description: "在 Web 侧栏中显示 Agent 的持久终端，人可以旁观并接管；同时提供对人自己终端的只读访问。"
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal-panel

[English](README.md) | 中文

## 概述

在 Web 侧栏中显示 Agent 的持久终端。本包注册一个 `ctx.terminals` 后端，其会话就是[终端控制器](../../api/terminal-controller/README.zh.md)提供的侧栏终端，因此 6 个 [`terminal_*` 工具](../tool-terminal/README.zh.md)的名称、参数和结果都不变，而每次 `terminal_open` 都会成为一个人可以旁观和输入的标签页。人第一次按键就接管该终端，此后 Agent 只能读取。另有两个只读工具，用于列出和读取人自己打开的终端。[实验终端 bundle](../terminal-bundle/README.zh.md) 挂载本包。

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

在隔离 `terminals` 的分组中挂载本插件，与注册表和工具放在一起，并且所在组合已经挂载终端控制器，Web 与 Desktop 组合就是如此：

```yaml
- name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - name: '@deepseek-ai/dsh-terminal'
    - name: '@deepseek-ai/dsh-terminal-panel'
    - name: '@deepseek-ai/dsh-tool-terminal'
```

### Agent 终端

`terminal_open` 按 bash 工具的方式解析 Session 的沙箱策略，并为调用它的 Agent 打开终端：受限模式在沙箱内运行 shell，`danger-full-access` 直接运行，终端里的命令不能申请更多权限。shell 会一直保留这一策略；Session 解析出的策略一旦不同（例如人切换了沙箱模式），`terminal_send` 就会失败并提示模型另开终端，读取、发送信号和关闭照常可用。终端以 `name` 参数或会话 id 为标题，从请求的目录或 Session 工作目录启动。shell 输出过内容、静默 `startupSilenceMs` 并占据前台后，工具才返回，并把渲染后的屏幕作为启动输出；人的启动文件会先运行。

`terminal_send` 写入文本和回车，在输出静默 `promptSilenceMs`、且 shell 或正在等待终端输入的程序占据前台时返回 `stdin_read`。安静的命令在 `idleSilenceMs` 后返回 `inferred_idle`，忙碌的命令在 `timeoutMs` 后返回 `timeout`，终端退出或关闭时返回 `session_exit`。取消发送会中断由这次输入启动的命令。结果从发送开始的那一行渲染屏幕，并拼接软换行；`terminal_read` 按页读取包括滚动缓冲区在内的渲染屏幕。

人在 Agent 终端中键入或粘贴后，`terminal_send` 和 `terminal_signal` 会失败并说明原因，`terminal_read` 照常可用，`terminal_close` 只把终端移出 Agent 的列表，shell 及其进程继续为人运行。接管之前，`terminal_close` 会结束 shell 并移除标签页。子 agent 会被拒绝，因为它们打开的终端不会出现在人正在查看的 Session 中。

### 用户终端

`user_terminal_list` 列出人控制的终端，包括起始目录和是否有命令正在运行。`user_terminal_read` 渲染其中一个终端最新的若干行。两者都不会写入终端。子 agent 会被拒绝，因为它们的 Session 中没有人的终端。`readUserTerminals: false` 会移除这两个工具。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backendType` | `shell` | 由侧栏终端提供的终端注册表类型 |
| `cols`、`rows` | `160`、`40` | 初始尺寸；打开的侧栏视图会把终端调整为面板大小 |
| `preferredShells` | `[]` | 在默认 shell 之前、从已探测 shell 中优先尝试的可执行文件名 |
| `environment` | `PAGER`、`GIT_PAGER` = `cat` | 添加到 Agent 终端环境的变量；配置的值会替换默认值，因此请在其中保留 `PAGER` 和 `GIT_PAGER`，否则 `git log` 等程序会停在分页器中 |
| `startupSilenceMs`、`startupTimeoutMs` | `300`、`15000` | 启动静默时长与启动时限 |
| `promptSilenceMs` | `300` | 发送后检查前台之前的静默时长 |
| `probeIntervalMs` | `1000` | 两次前台检查之间的最短间隔 |
| `idleSilenceMs`、`timeoutMs` | `3000`、`30000` | 以 `inferred_idle` 结束发送的静默时长，以及发送时限 |
| `maxReadBytes` | `262144` | 读屏、发送输出和启动输出的 UTF-8 字节上限 |
| `readUserTerminals` | `true` | 注册两个用户终端工具 |

`promptSilenceMs` 大于 `idleSilenceMs`、`idleSilenceMs` 大于 `timeoutMs`，或 `startupSilenceMs` 大于 `startupTimeoutMs` 时，加载会失败。终端控制器的 `maxAgentTerminals` 和 `maxTerminals` 限制 Agent 可打开的终端数量。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件注册与指引 |
| [`src/config.ts`](src/config.ts) | 配置与时序校验 |
| [`src/backend.ts`](src/backend.ts) | 拒绝子 agent、打开终端与启动 |
| [`src/session.ts`](src/session.ts) | 发送、就绪判定、输出读取、信号与释放 |
| [`src/tools.ts`](src/tools.ts) | 用户终端工具 |

### 就绪判定

后端不向 shell 的启动过程添加任何内容，因为 SSH 等执行环境没有 Host 上的文件。就绪判定结合输出静默与前台进程组：前台是 shell 自己的进程组，说明它停在提示符；在 Linux 上，provider 还会报告正在读取终端输入的程序。在 macOS 上每次检查可能启动两次 `ps`，所以只在静默之后检查，且每 `probeIntervalMs` 至多一次。

### 输出

一次发送会先等待已收到的输出处理完，再标记光标所在逻辑行的起点，然后写入输入。后台读取会取出标记之后的完整行，并把标记移到仍在写入的那一行；结果渲染其余部分。标记被滚出滚动缓冲区时会报告输出已截断。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [终端控制器](../../api/terminal-controller/README.zh.md)——Agent 终端的分配、接管与读屏。
- [侧栏终端](../../client/ui-sidebar-terminal/README.zh.md)——Agent 终端如何出现，以及如何识别人的键入。
- [终端工具](../tool-terminal/README.zh.md)——本后端承载的 6 个工具。
- [终端服务](../../terminal/terminal/README.zh.md)——注册表约定与所有权规则。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

本插件在终端工具的指引之后贡献以下固定段落：

##### 可见终端指引

```markdown
Terminals you open with terminal_open appear in the user's side panel. The user can watch them and type into them; once the user types into one, you can only read it, and terminal_close then only removes it from your terminal list while its shell and processes keep running for the user. Use visible terminals for long-running processes the user should see, such as dev servers and watchers; keep using bash for short commands whose output you need now. Commands in these terminals run in the session sandbox and cannot request more access; when one is denied permission, run it with bash instead. Never type passwords or one-time codes; ask the user to enter them in the terminal.
```

#### Token 影响

插件启用期间，每次请求都有少量固定输入开销。

#### KV Cache 影响

插件保持加载时前缀稳定；加载或卸载插件会让活跃 Session 的系统提示词变化一次。

### 工具 schema

#### 模型看到什么

两个 schema 列在 [`dsh-terminal-panel` 目录小节](../../../docs/tool-catalog.zh.md#deepseek-aidsh-terminal-panel)中。6 个终端工具沿用 [`dsh-tool-terminal`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-terminal) 的 schema。

#### Token 影响

`readUserTerminals` 开启时有固定的 schema 开销。

#### KV Cache 影响

工具可见性和定义不变时前缀稳定。

### 工具结果

#### 模型看到什么

`user_terminal_list` 每个终端返回一行：id、标题、起始目录和 `command running: yes | no | unknown`。`user_terminal_read` 返回渲染后的屏幕文本，后接 `[lines: <begin>-<end> of <total>]`，被截断时再加 `[output truncated]`。终端工具的结果包含 Agent 终端的渲染屏幕。人自己终端的屏幕文本会进入 Session 日志和模型请求。

#### Token 影响

取决于数据，受 `maxReadBytes` 限制；结果会保留在历史中直到压缩。

#### KV Cache 影响

只追加；新结果跟在可复用的请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **接管后无法交还**——人在 Agent 终端中键入后，Agent 无法再取得输入权，只能另开终端。
- **终端内不能提权**——需要更多权限的沙箱命令必须改用 bash 重新运行，bash 可以申请审批。
- **就绪是推断的**——静默的 shell 内建命令（如 `wait`）会被当作 `stdin_read`；在 macOS 上，等待输入的程序要到 `idleSilenceMs` 后才返回；停在提示符的嵌套 shell 返回 `inferred_idle`。
- **用户终端只读当前屏幕**——`user_terminal_read` 返回当前屏幕，不等待新输出。
- **沙箱中的启动文件**——受限 shell 无法写入可写目录之外的文件，因此会写这类文件的启动文件可能在终端中打印错误。
- **完全访问下共用历史**——`danger-full-access` 终端沿用继承的 `HISTFILE`，通常就是人自己的历史文件，因此 Agent 的命令会追加到这份历史中，Agent 的 shell 也会载入它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
