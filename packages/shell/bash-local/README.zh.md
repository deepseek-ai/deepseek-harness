---
description: "面向部署方与维护者的默认 POSIX Bash 执行器说明，用于选择、配置或排查基于 shell seam 的非隔离命令执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-local

[English](README.md) | 中文

## 概述

`dsh-bash-local` 是 POSIX 上的默认 Bash 执行器：每条命令都以全新的非登录 `bash -c` 进程运行，不读取 rc 文件，因此调用之间不会残留任何 shell 状态。它会为每条命令应用已配置的预算——工作目录、超时、输出上限——对超时与取消进行分类，并在流溢出时返回有界输出与 spill 文件恢复。命令以 harness 进程自身的权限运行：本执行器不做任何隔离，需要沙箱能力时请组合 `dsh-bash-sandbox`。挂载后，面向模型的 `bash` 工具会与它对接。

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

当组合需要在 POSIX 上执行 Bash 命令且不需要隔离时，挂载此执行器。它注册为 `ctx.shell`，面向模型的 `bash` 工具会立即基于它工作：agent 调用工具，命令即以全新 `bash -c` 进程按下面的预算运行。

### 最小配置

按你需要的预算加载执行器；每个字段都有默认值，因此最小的组合就是单独一个插件条目。当组合了设置提供方时，用户段会叠加在该条目之上，预算无需重载即可在运行时变更（见[运行时调整预算](#adjusting-budgets-at-runtime)）。

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace
    timeoutMs: 120000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cwd` | `process.cwd()` | 命令的默认工作目录 |
| `timeoutMs` | `120,000` | 默认前台超时，单位为毫秒 |
| `maxTimeoutMs` | `600,000` | 每次调用超时覆盖值的上限 |
| `maxOutputBytes` | `64,000` | 每流内存输出上限；溢出后 spill 到临时文件 |
| `maxSpillBytes` | `67,108,864` | 每流完整输出的 spill 上限 |
| `graceMs` | `3,000` | 终止升级与退出后管道排空的宽限时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-bash-local)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 运行命令

用 `run` 运行命令并从结果读取输出。非零退出、超时或取消都会 resolve 为描述性结果——只有基础设施失败才 reject。每次调用的 `timeoutMs` 覆盖值受配置上限约束，`workdir` 未设置时则回退到配置的默认值；受信任的前台调用方还可以为单次调用提高 stdout 捕获预算，而 stderr 与后台运行仍使用 `maxOutputBytes`。环境默认面向模型：`NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat` 可防止分页器与 ANSI 颜色破坏输出，调用方显式提供的条目仍然优先。

```text
const result = await ctx.shell.run(ctx.shell.resolve({ command: 'ls -la' }))
if (result.timedOut) console.log('timed out after', result.timeoutMs)
```

### 后台进程

调用 `start` 即可在后台运行命令；它立即返回句柄，且不应用任何超时。`readOutput()` 把流增量合并为一次消费式读取，并在 `[stderr]` 分段下标记 stderr；`kill()` 停止进程组；`done` 在进程关闭时结算且绝不 reject。job id、所有权、轮询与通知属于通用 `ctx.jobs` 运行时，工具层会把句柄注册进去。

<a id="adjusting-budgets-at-runtime"></a>
### 运行时调整预算

当组合了设置提供方时，本执行器以组合条目为 base 注册该能力共享的 `shell` 设置命名空间，因此 `settings.yaml` 中的用户段会叠加其上，下一条命令即按新预算运行。schema 无法判定的值——正有限数字与 `graceMs` 的定时器上界——会在写入时被拒绝，运行中的执行器保持它最后一份可用的段；没有提供方时，运行的就是组合条目。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释执行器的设计并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计概念

本执行器是基于 subprocess 能力的 `ctx.shell` seam 的 Service Provider：它负责所有 bash 层职责——命令默认化与上限、deadline 融合与原因分类、面向模型的终端环境，以及后台读取合并——而进程组机制（有界 spill 输出、凭据清除、终止升级、dispose（资源释放））属于 subprocess 服务。每次调用都 spawn 全新的非登录 `bash -c`，不读取 rc 文件，因此命令是确定性的，shell 状态绝不会在调用之间泄漏。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`LocalBashExecutor`、`Config`、设置段接线 |
| — | 不发布运行时不变式伴生入口；约定在所属 seam 处执行。 |
| `tests/executor.spec.ts` | 已演练的行为：预算、分类、后台句柄、归属 |
| `tests/settings.spec.ts` | 设置段叠加在组合条目之上 |

### 主要流程

一次调用分三步：`resolve()` 从配置填充 `workdir`/`timeoutMs`/`stdoutMaxBytes`（并限制每次调用的覆盖值）；`run` 把按配置钳位的超时与调用方的中止信号融合为一个 deadline，再以显式字节上限与 `graceMs` 通过 `ctx.subprocess` spawn `['bash', '-c', command]`；结算的 subprocess 结果被分类——只有执行器自身的超时报告 `timedOut`，上游取消报告 `aborted`，自身因信号终止的命令两者皆不报告——并投影为带收集输出的 `ShellRunResult`。

### 不变式与归属

- `graceMs` 预算必须为正有限值且不大于 `MAX_TIMER_DELAY_MS`，这样 Node 就能用一个定时器表示它；无效值在写入处被拒绝。
- 环境分层固定：先是终端覆盖值，然后是调用方的 `env`，最后才是受信任的 `dshEnv` 快照；subprocess 服务独立清除环境中的凭据与继承的 `DSH_*` 名称。
- 后台进程属于 subprocess 服务：它能在仅重载执行器后存活，并在服务 dispose 时被终止并 join。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当执行器约定不够用时阅读以下页面。它们从 seam 进入受限的兄弟包及其底层机制。

- [shell seam](../shell/README.zh.md) —— 本提供方实现的执行器约定，包括请求/spec 拆分。
- [bash-sandbox](../bash-sandbox/README.zh.md) —— 需要沙箱能力时替换组合的受限执行器。
- [tool-bash](../tool-bash/README.zh.md) —— 基于本执行器的面向模型 `bash` 工具。
- [Bash 执行器子系统](../../../docs/subsystems/shell.zh.md) —— 请求/spec 词汇、结果与完整的服务约定。
- [subprocess-local](../../subprocess/subprocess-local/README.zh.md) —— 本执行器背后的进程组机制。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-bash` 间接影响；该工具会渲染本执行器有界的 stdout/stderr 尾部、后台进程增量、spill 文件路径与基础设施失败。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀的任何变更由具名消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本执行器何时不合适。它们是当前包约束，不是路线图。

- **自身不提供隔离**——命令以 harness 进程的权限运行；需要隔离的部署组合 `dsh-bash-sandbox`，每次调用的 allow/deny/ask 策略则属于工具的 `pre-execute` waterfall。
- **没有持久 shell 或 PTY**——每次调用都启动全新的非登录 `bash -c`；仅持久化 cwd 与交互式终端会话均继续延期，直到真实工作流需要它们。
- **仅支持 POSIX**——`bash` 二进制已硬编码，底层服务的进程组语义也是 POSIX 的；不支持 Windows。
- **后台 spawn 失败提示只交付一次**——subprocess 服务不会为从未真正运行的进程缓冲任何输出，因此执行器把 `spawn failed: …` 注入恰好一个 `readOutput()` 增量；丢弃了该增量的读取方无法再恢复它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
