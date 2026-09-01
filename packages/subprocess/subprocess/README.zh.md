---
description: "面向组合作者与能力消费方的子进程服务（`ctx.subprocess`）说明：启动、观察并终止受管子进程与终端会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess

[English](README.md) | 中文

## 概述

任何需要运行子进程的组合都可以通过 `ctx.subprocess` 启动完全明确指定的子进程或真实终端会话，收到带流与退出事实的活动句柄，并按需终止整棵进程树。本服务提供可执行文件查找、共享的环境清理与有界输出捕获，而每一项默认值——argv、时限、shell 语义——都显式留在请求上，由消费方能力 seam 决定进程的含义。组合只需挂载一个提供方实现（如 `dsh-subprocess-local`）来注册该服务；seam 包本身是抽象约定，不是可直接加载的插件。本包不直接接触模型：进程输出与生命周期的渲染由消费方工具负责。

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

在需要运行子进程的组合中挂载一个 subprocess 提供方，并从拥有该命令的能力包调用 `ctx.subprocess`。常用路径是显式的：解析可执行文件、用完全明确的请求 spawn、读取你要的输出，并在工作完成时终止进程树。

### 挂载服务

每个组合由唯一一个提供方注册 `ctx.subprocess`；把它与经由它 spawn 的消费方放在一起加载——bash 执行器、LSP 主机、PTY shell 后端或进程外 subagent 后端。加载第二个提供方会快速失败（每个上下文只有一个服务，这是 cordis 的标准行为）。

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-bash-local'
```

### 启动受管进程

请求完全明确：程序与参数、工作目录、每条流一种 stdio 处置方式、终止宽限期、可选的中止信号与可选的环境覆盖。进程关闭时，`done` 以退出事实（`exitCode` 与 `signal`）resolve，且只在 spawn 层面失败时 reject；收集输出在退出后仍可读取。

```text
const executable = await ctx.subprocess.resolveExecutable('bash')
const handle = ctx.subprocess.spawn({
  argv: [executable, '-c', 'echo hello'],
  cwd: '/workspace',
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: 'inherit' },
  graceMs: 5000,
})
const { exitCode, signal } = await handle.done
const output = handle.collected.stdout?.readFrom(0)
```

### 选择输出投递方式

- `'pipe'` 把原始流交给你做自己的协议分帧——LSP 主机用 JSON-RPC，ACP 后端用 ndjson。
- `'inherit'` 让子进程直接写父进程自己的流，用于直通诊断输出。
- collect 对象缓冲一段有界的进程内尾部；加上 `spill` 上限后，完整流还可以从 spill 文件中恢复。

读取基于偏移量且从不消费：后台读取与最终批量读取可以共享同一条流，而不会抢走彼此的字节。

### 管理进程生命周期

终止在任何平台上都以进程树为范围：`terminate()` 执行 SIGTERM → 宽限期 → SIGKILL 升级（Windows 上立即强制终止），幂等，进程树消亡后为空操作。请求的中止信号会启动同样的升级，因此消费方自有的 deadline 可以取消整棵进程树。`waitForExit()` 只有在整棵进程树都退出后才会 resolve，而非只看直接子进程，因此在拆卸返回之前仍可观察到仍在运行的辅助进程。时限与原因分类归调用方所有；服务只做响应。

### 运行终端会话

对于交互式程序，`spawnTerminal` 分配真实 PTY：写入文本、读取 UTF-8 输出、检查当前前台进程组并向其发送信号，以及等待一次 `terminate()`，让提供方仍可观察到的每个会话成员完全停稳。就绪状态、scrollback 与提示符策略仍归 PTY 消费方所有。

### 每个子进程起步时的环境

子进程永远不会隐式继承 harness 的环境秘密：形似凭据的名称与环境中的 `DSH_*` 事实都会被清除，调用方显式的 `env` 在该清除之后合并。有意转发的凭据或当前的 `DSH_*` 部署事实仍会到达子进程；显式的 `undefined` 墓碑值则移除一个普通的环境项。

### 可能出错的地方

无法解析的可执行文件会以稳定的错误快速失败。从未启动成功的 spawn 会让 `done` reject；从未运行过的进程没有任何缓冲输出。脱离进程树或会话的 daemon 化子进程可能比终止更长寿——提供方 README 会记录各自的可观察性限制。当传输拥有自己的 spawn（SDK 客户端、MCP）时，请绕开本服务并直接导入 `scrubbedParentEnv`，让环境策略保持单一来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 seam 背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本 seam 建立在一个分离之上：服务负责进程坐标与生命周期；消费方负责定义进程的含义，以及决定塑造该进程的每一项默认值。正因如此，spawn 请求完全明确——没有任何隐藏的子进程服务默认值——`SubprocessOutcome` 也只携带退出事实：时限、拆卸阶梯与原因分类归调用方所有。`dsh-shell` 的 request/spec 拆分是这条规则的所属模板。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `SubprocessRuntime`、`ctx.subprocess` 注册、共享的 `scrubbedParentEnv` 清除 |
| [`src/types.ts`](src/types.ts) | 词汇：spawn spec、stdio 模式、句柄、读取器、结果、`DSH_*` 命名空间 |
| — | 不发布运行时不变式伴生入口；观察由提供方负责。 |

### 数据模型与流程

spawn 立即返回活动句柄；请求的中止信号驱动与 `terminate()` 相同的终止升级。收集模式的读取器无游标：偏移量是调用方拥有的全流字节坐标，因此独立读取器不会消费彼此的输出，偏移量滑出内存尾部的读取标记为 `lossy`，并在 spill 文件存在时指向它。`spawnTerminal` 是一项底层原语，因为普通管道无法分配控制终端或清理终端会话成员。

### 生命周期与不变式

每个上下文只注册一个实现；加载第二个会抛错（cordis 标准行为）。服务自身的 dispose（资源释放）会终止所有仍在运行的受管进程并等待其退出，因此进程生命周期在消费方重载后依然延续。`argv` 绝不经过 shell 解释；需要 shell 的消费方自行传入 `['bash', '-c', command]`。终端分配的取消（spec 信号）与已发布句柄的生命周期相互独立。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从穷尽式类型参考逐步进入各提供方，以及 seam 背后的决策证据。

- [子进程子系统](../../../docs/subsystems/subprocess.zh.md)——spawn spec、输出读取器、结果与完整的 `DSH_*` 环境。
- [dsh-subprocess-local](../subprocess-local/README.zh.md)——实现本约定的本地宿主提供方。
- [dsh-subprocess-e2b](../../e2b/subprocess-e2b/README.zh.md)——同一 seam 的远程 E2B 提供方。
- [dsh-bash-local](../../shell/bash-local/README.zh.md)——最大的消费方：经由本服务运行 bash 命令。
- [subprocess seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.zh.md)——进程部分为何成为独立的 seam，以及随之迁移的内容。

-----

<a id="model-experience"></a>
## 模型体验

通过消费方 seam（例如 bash 执行器家族）间接影响，它们负责进程输出与生命周期的全部面向模型渲染。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 何时不合适，或何时把工作留给消费方。它们是当前包约束，不是对比或任务积压。

- **由 SDK 管理的 spawn 仍在服务之外**——拥有内部 spawn 的传输（SDK 客户端、MCP）无法把该调用路由到本服务；它仍可导入 `scrubbedParentEnv`，使环境策略保持单一来源。
- **拆卸阶梯归消费方所有**——该 seam 只提供信号动词与整棵进程树的等待，不提供现成的停稳序列；每个进程外消费方自行编码其子进程的配合方式（ACP 后端以 stdin EOF 打头的阶梯是仓库内模板）。
- **可观察性取决于提供方**——脱离进程树或会话的 daemon 化子进程可能比终止更长寿；提供方记录各自的执行基底限制，seam 不新增持续的进程表监视器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

未来：非 shell 运行器。该 seam 拆分的目的就是让直接 argv 执行器或 worker supervisor 无需深入 bash 内部即可消费它；目前尚无任何实现交付，终端原语也把就绪策略留在其消费方。

</details>
