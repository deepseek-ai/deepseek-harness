---
description: "面向开发者与维护者的 bash 执行器 seam 说明，用于选择、组合或实现基于 ctx.shell 的命令执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-shell

[English](README.md) | 中文

## 概述

`dsh-shell` 定义运行 shell 命令的执行器服务（`ctx.shell`）：前台命令在结束时以有界输出 resolve，后台进程则立即返回句柄。仓库中的每个 shell 执行器——本地 Bash、沙箱 Bash、本地 PowerShell、沙箱 PowerShell——都实现这同一个约定，因此面向模型的 `bash` 与 `pwsh` 工具在任何一个之上都能不加改动地工作。调用方先提交请求，再在任何命令运行前拿到一份默认值与上限都已显式填好的 spec。该服务本身从不向模型渲染任何内容；所有模型可见的输出与沙箱指引都归 shell 工具所有。

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

当 agent 或进程内插件需要运行 shell 命令并读取输出，或启动后台进程并轮询它时，使用 `ctx.shell`。它是每个 shell 执行器与面向模型的 `bash`/`pwsh` 工具共同依赖的约定，因此基于它编写的代码可以运行在任意执行器实现之上。

### 前台命令

用已解析的 spec 调用 `run` 即可在前台执行命令。promise 在命令结束时 resolve：非零退出、执行器超时终止或调用方中止终止都是结果，绝不是 rejection。`run` 只在基础设施失败时 reject，例如工作目录不可用或缺少 shell。结果携带退出码或信号、是超时还是中止截断了运行，以及收集到的 stdout/stderr；流超出预算时还附带 spill 文件路径。

```text
const result = await ctx.shell.run(ctx.shell.resolve({ command: 'ls -la' }))
console.log(result.exitCode, result.stdout.text)
```

### 后台进程

用已解析的 spec 调用 `start` 即可启动后台进程；它会立即返回句柄，且不应用任何超时。用 `readOutput()` 增量读取输出——连续读取绝不会重复交付，有损读取会指向完整流的 spill 文件。用 `kill()` 终止提供方管理的 range（直接命令结束后返回 `false`），并等待 `done` 完成直接命令结算。job id、所有权、轮询与通知属于通用 `ctx.jobs` 运行时，工具层会把句柄注册进去。

### 请求与已解析 spec

每次执行都从带可选字段的 `ShellExecRequest` 开始；执行器的 `resolve()` 在任何东西运行之前，把它变成默认值与上限都已显式填好的 `ShellExecSpec`。这一请求/spec 拆分正是仓库在包边界显式解析的模板：调用方绝不依赖 `run` 或 `start` 内部隐藏的默认值。`resolve()` 从执行器配置填充工作目录与超时、对每次调用的覆盖值设上限，并按原样携带可选输入——`stdin`、普通 `env` 与受信任的 `DSH_*` 快照。

### 选择并组合一个执行器

seam 本身不是执行器：每个组合只挂载一个提供方，工具即可不加改动地工作。在 POSIX 上，`dsh-bash-local` 以全新的 `bash -c` 进程运行命令，`dsh-bash-sandbox` 则通过沙箱能力限制每条命令；在 Windows 上，对应实现是 `dsh-pwsh-local` 与 `dsh-pwsh-sandbox`。`bash` 与 `pwsh` 工具只在挂载沙箱执行器时公布升权字段。最小的组合只需执行器本身：

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace
```

### 共享的退出状态约定

工具结果以机器可读的退出标记结尾——`[exit code: N]` 或 `[killed by signal: X]`——模型因此总能知道命令如何结束。seam 拥有该标记格式，以及把渲染结果拆回输出正文与结构化退出状态的 `parseExitStatus` 辅助函数，使 `bash` 与 `pwsh` 两个工具永远不会在此漂移。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 seam 的设计并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包是标准能力 seam 中的一个角色：命名执行器约定的 Service Definition，Service Provider 与 Consumer 各自拆分，使每个角色都能独立演进（见[能力 seam 笔记](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）。两项决策锚定了该约定：

- **边界处的显式解析。** `resolve(request)` 是应用默认值与上限的唯一位置；`run` 与 `start` 只接受已解析的 spec，绝不再次默认化，因此实现内部不会藏有隐藏的兜底值。
- **无任务语义的后台句柄。** `start` 返回不带 id 或所有者的 `ShellProcess`；job 身份、所有权与生命周期属于通用 `ctx.jobs` 运行时，使执行器与会话保持独立。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `ShellExecutor` 服务与共享设置命名空间 |
| [`src/types.ts`](src/types.ts) | 请求/spec 词汇、`ShellRunResult`、`ShellProcess` 与沙箱事实 |
| [`src/render.ts`](src/render.ts) | `parseExitStatus`：shell 工具共享的退出状态标记约定 |
| — | 不发布运行时不变式伴生入口；执行器与策略负责观察。 |

### 设置命名空间

`SHELL_SETTINGS_NAMESPACE` 由此处导出而非由某个提供方导出，因为它命名的是能力而不是实现：一个宿主只组装一个 `ctx.shell` 提供方，因此各提供方共享同一个命名空间而永不冲突，在平台间携带的设置文档也能在两边继续解析。

### 后台生命周期与归属

后台进程属于 subprocess 服务而非执行器：它能在仅重载执行器后存活，并在组合拆解时被终止并 join。实现必须遵守 seam 的语义——`run` 只在基础设施失败时 reject；`start` 立即返回且不设超时，其 `done` 绝不 reject（subprocess provider rejection 以 `killed` 结算，并把不声明阶段的错误写入 stderr）；`readOutput` 是消费式的，有损读取会报告 spill 文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 seam 约定不够用时阅读以下页面。它们从共享子系统参考逐步进入具体执行器与面向模型的工具。

- [Bash 执行器子系统](../../../docs/subsystems/shell.zh.md) —— 请求/spec 词汇、结果与完整的服务约定。
- [bash-local](../bash-local/README.zh.md) —— 默认 POSIX 执行器：全新的 `bash -c` 进程、预算与 deadline。
- [bash-sandbox](../bash-sandbox/README.zh.md) —— 受限执行器：沙箱模式、拒绝与升权。
- [tool-bash](../tool-bash/README.zh.md) —— 基于该 seam 的面向模型 `bash` 工具。
- [能力 seam 笔记](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) —— 本 seam 遵循的 Service Definition / Provider / Consumer 拆分。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-bash` 间接影响；该工具会将执行器输出与沙箱事实转为指引和保留的工具结果 token。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀的任何变更由具名消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 不提供什么。它们是当前包约束，不是路线图。

- **没有交互式输入词汇**——`stdin` 只在 spawn 时写入一次并关闭；seam 没有向运行中任务继续输入的通道，也没有 PTY 会话概念。
- **前台超时始终由执行器负责**——seam 上由调用方负责 deadline 的模式已由[工具调用超时策略笔记](../../../.agents/notes/implemented/architecture/2026-07-07-tool-call-timeout-policy.zh.md)明确延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
