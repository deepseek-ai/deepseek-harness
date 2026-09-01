---
description: "dsh 的一次性任务模式：从命令行运行单个任务并打印最终答案，供用户脚本化或自动化 dsh。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-headless

[English](README.md) | 中文

## 概述

`dsh-headless` 从命令行运行一个 dsh 任务并打印最终答案，然后退出——没有 GUI、没有服务器、没有浏览器。输入 `dsh --profile headless "run the tests"`，agent（智能体）会以与其他表层相同的模型、工具与安全默认值完成该任务。它非常适合脚本、CI 与一次性任务：进程不打开任何端口，也不会留下任何后台运行的东西。退出码告诉你结果——任务完成时为 0，中止或出错时为 1。主要边界：每次调用只运行一个任务，没有交互式后续。

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

运行一个任务，获得最终答案，然后退出。任务就是命令行本身，因此整条命令就是最小的可运行示例。

### 运行一次性任务

```sh
dsh --profile headless "run the tests"
```

agent（智能体）会完成该任务，把提供方的每个非空推理增量流式写入 stderr 的 `dsh: reasoning:` 段，然后把最终答案写入 stdout 并退出。连续推理增量保持在同一段中；提供方未给尾换行时，runner 会在后续输出前结束该段。没有推理内容的成功运行保持 stderr 为空；失败时退出码为 1，并以 `dsh: <code>: <message>` 向 stderr 写入错误。缺失或空白任务会在任何内容运行前被拒绝。任务文本通过唯一的 `task` 设置提供：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `task` | 必填 | 单次运行的任务文本 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-headless)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 何时使用

在脚本化或自动化的 dsh 运行中使用 headless——CI 步骤、批处理任务、从终端快速获取答案。当需要多轮交互会话或 GUI 时请避免它；浏览器表层（[dsh-web-app](../web-app/README.zh.md)）负责这类场景。进程只为本次运行而存活，不打开监听端口，并且自行退出，因此适合等待进程结束的流水线。

### 帮助与任务错误

`dsh --profile headless --help` 打印该命令的帮助文本并直接退出，不运行任何内容。缺失或只有空白的任务属于用法错误：什么都不运行，进程退出 1。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

runner 是核心 API 载体之上的直接驱动器：它通过注册表创建一个全新的 Agent（智能体），并把所属的持久化事件区间折叠成一个进程级结果。

### 运行流程

runner 等待整个应用结算（`ctx.get('loader')?.await()`），确保已组合的工具与适配器不会半挂载，读取共享的 [`agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择，用该 provider 与模型创建一个全新的持久化 Agent（智能体），并把任务作为普通用户消息提交。它把该 Agent 的非空推理增量流式写入 stderr、等待完全停稳，然后 flush Session，并把所属区间（从 `firstSeq` 起）折叠为最后一条非空 `assistant/message` 文本与最终 `turn/end` 原因。最后，它把最终文本写入 stdout 并请求退出。

### 叠加在 base 之上的 patch 表层

patch 叠加在 `dsh-base` 之上：继承投影缓存，在基础 `system-prompt` 行上设置编码 persona，保留与 Web 表层相同的临时进程级 PTC mode 开关（`DSH_TOOLS_MODE`），禁用共享的 HMR 行，把 PTC mode 的 worker 作为核心执行能力插入，并挂载启动提供方与 runner。缓存为每个已持久化的一次性会话写入检查点，供后续消费方使用；其持久性屏障会在发布缓存行前 flush 所覆盖的日志前缀，因此可能拆分原本会合并的 JSONL 行。启动提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)），读取位置参数、打印应用自己的 `--help`，并提供 `headlessStartup`；runner 注入该服务，再从惰性配置中读取任务。

### 退出映射

最终 `turn/end` 完成时退出码为 0；任何其他结果——aborted、error，或所属区间内没有轮次——退出码为 1。结束原因为 `error` 时还会向 stderr 写入 `dsh: <code>: <message>`。直接驱动器失败（例如 Agent 创建失败）向 stderr 写入 `dsh: <message>` 并退出 1。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `headless-runner` 插件：运行流程、输出约定、退出映射 |
| [`src/startup.ts`](src/startup.ts) | `headless-startup` 提供方：任务位置参数与 `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的一次性 patch |
| — | 不发布运行时不变式伴生入口；可观察的行为属于进程级组合，本包只持有静态 patch 列表。 |
| [`tests/headless.spec.ts`](tests/headless.spec.ts) | 运行流程、汇总、flush 与退出映射 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |

### 不变式归属

不发布不变式伴生入口，因为 runner 的可观察约定（stdout 的最终文本、按轮次结束原因决定的退出码）是进程级的、由启动器 e2e 负责；插件不注册任何内容，树内也没有任何可变关系可审计。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你想深入了解共享核心、兄弟 GUI 或命令行交接时，阅读以下页面。

- [组合包包映射](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——headless 运行其上的共享核心。
- [dsh-web-app](../web-app/README.zh.md)——用于多轮工作的交互式浏览器兄弟表层。
- [dsh-cmdline](../../boot/cmdline/README.zh.md)——启动器如何把命令行交给应用。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-headless)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 runner 把任务作为普通用户消息提交，提示词与工具由组合出的 base 与 headless 行提供。

#### KV Cache 影响

runner 不向请求前缀添加任何内容；它只是把一条用户消息驱动经过组合出的配置树。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你 headless 何时不适用、它需要 `dsh` 启动器提供什么。它们是当前包约束，不是通用的 CLI 对比或任务积压。

- **每次运行一个任务**——任务得到回答后进程即退出；没有交互式后续，因此多步工作请拆成多次运行。
- **通过 `dsh` 启动器运行**——以其他方式启动 headless profile 会在启动时失败，因为只有启动器能请求进程退出。
- **首个 token 前没有心跳**——提供方发出第一个非空推理增量前，stderr 保持静默；延迟首个 token 的提供方不会更早给出进度信号。
- **推理进入 stderr 日志**——重定向与监督进程可能保留更多且可能敏感的模型输出；需要时应把 stderr 路由到受控位置。
- **只打印推理和最终答案**——没有 assistant 消息的运行向 stdout 打印空行并以 1 退出；中间工具输出不会打印。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
