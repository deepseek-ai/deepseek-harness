---
description: "在全新 Node 进程中运行 TypeScript 程序，使用会话文件系统沙箱、受管清理以及可配置的执行与输出限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime-node

[English](README.md) | 中文

## 概述

在与 Bash 相同的平台沙箱策略下执行模型编写的 TypeScript，并通过异步绑定调用 Host 提供的函数。每次调用启动一个全新的 Node 进程，返回捕获日志、精确 JSON 值或结构化失败。直接 Node API 在所选限制内仍可使用。经过时间截止、输出上限和 V8 堆限制约束执行；取消和完成都会终止受管进程范围。请求受限模式但沙箱后端不可用时，执行失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 `fs`、`subprocess`、`sandbox` 与 `sandboxPolicy` 的组合中挂载本提供方。`dsh-tools` 的 PTC 模式传入调用 Session 的目录和常设策略；直接运行时消费方在执行前解析这些选项。

### 配置

在所需服务可用后，配置提供方条目：

```yaml
- name: '@deepseek-ai/dsh-ptc-runtime-node'
  config:
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 67108864
    maxOldGenerationSizeMb: 512
    maxMessageBytes: 134217728
    maxPendingCalls: 128
    graceMs: 3000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `120,000` | 默认经过时间截止，包括嵌套工具与审批等待 |
| `maxTimeoutMs` | `600,000` | 解析器应用的经过时间截止上限 |
| `maxOutputBytes` | `67,108,864` | 序列化日志与完成值或诊断的合计预算 |
| `maxOldGenerationSizeMb` | `512` | V8 老生代堆上限，单位 MiB |
| `maxMessageBytes` | `134,217,728` | 控制帧、未完成参数字节和排队控制写入的上限 |
| `maxPendingCalls` | `128` | 同时进行的 Host 绑定调用数量上限 |
| `graceMs` | `3,000` | 受管终止与输出排空宽限时间 |
| `nodeExecutable` | 当前 Node 可执行文件 | 在子进程执行世界中解析的可执行文件 |
| `bootstrapPath` | 包内 bootstrap | 该执行世界中预先安装的构建后 bootstrap 的可选绝对路径 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-ptc-runtime-node)定义可接受的配置字段。`resolve(request)` 补全 cwd、数值或 null 截止选择与执行策略；`run(spec)` 接受这些已解析输入，不补缺省值。

### 执行与结果

程序是异步函数体：支持顶层 `await` 与 `return`，且只接受可擦除 TypeScript。成功调用以 `result.value` 返回无损 JSON 值，以 `result.logs` 返回捕获文本。`result.sandbox` 独立于程序结果报告所选模式、观察到的拒绝，以及后端完整或部分的强制能力。

直接文件系统、网络与子进程操作仍是 Node 操作，受所选 OS 沙箱约束。嵌套 Host 绑定通过控制通道调用；PTC 工具调用保留注册表的可见性、排序、日志和审批规则。运行程序不会改变 Session 的常设策略，也不会在拒绝后自动重放程序。

### 截止时间与取消

PTC 消费方按 [dsh-tools](../../core/tools/README.zh.md#ptc-mode) 的说明公开逐次超时与经审批的沙箱选择。运行时只读 `timeout` 描述符向该消费方报告有效默认值与上限。 其 `executionInstructions` 在面向模型的 schema 中说明全新 Node 状态、直接 Node API、空程序环境和文件策略。

省略 `timeoutMs` 使用配置的经过时间默认值；数值请求经过验证并封顶。服务调用方可以显式传入 `timeoutMs: null` 来省略经过时间定时器，工作流适配器即如此；`run_code` 仍只接受正数覆盖值。启用的截止覆盖运行时准备和执行，包括等待嵌套工具或审批的时间。它不是 CPU 计量器。超时或取消通过 Host 的受管进程所有者停止同步循环；成功完成也会清理该受管范围。选择结果后、清理前停止计时器，因此调用可能要在执行截止之后等待清理结算才返回。

### 失败

程序解析错误与抛出异常为 `exception`；截止到期为 `timeout`；取消为 `abort`；畸形或超量控制通信为 `protocol`；约束不可用为 `sandbox-unavailable`；进程提前退出或受管清理失败为 `worker-exit`。进程提供方保留与执行基底无关的失败名 `worker-exit`。有损完成值为 `invalid-output`，外层结果超限为 `output-limit`，并保留能容纳的日志前缀。无效或不支持的选项，以及资源释放后的调用，以调用方误用拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Host 负责策略、截止时间、绑定查找和进程清理。子进程负责程序求值与绑定代理；即使使用预期的控制描述符，模型编写的代码仍是不可信对端。

### 启动与控制

Host 擦除可擦除类型，在配置的执行世界中解析可执行文件与 bootstrap，通过 `ctx.sandbox` 等待 argv 限制准备完成，再通过 `ctx.subprocess` 启动。限制准备完成后会再次检查取消状态，因此提供方在取消后返回也无法启动程序。接管继承的控制通道后，子进程在 OS 环境中只保留可执行文件搜索路径、Windows 系统路径和临时路径，并将程序可见的 `process.env` 替换为空字典。Windows ACL 初始化接收父进程各自的 `TEMP` 和 `TMP` 值以使用共享授权锁，然后在启动程序前将二者替换为私有目录。这些原生路径使嵌套进程创建和原生临时文件 API 仍可正常工作。堆上限通过 Node argv 或为打包可执行文件由提供方构造的 `NODE_OPTIONS` 值传递；环境中的加载器和调试器标志会被丢弃。

带长度分帧的 JSON 与 stdout/stderr 分开传输。Host 限制帧与排队写入，在分派前验证调用身份和已声明的绑定名，并拒绝无效通信。子进程刷新终态帧后仍保持控制通道打开，直到 Host 关闭通道。提交终态帧后，子进程忽略后续绑定回复，不再发送程序控制消息。输出捕获计量序列化日志加完成值或诊断；固定结果信封字段与沙箱元数据不计入该账本。

### 源代码与构建后 bootstrap

源代码执行加载仅含可擦除语法的 bootstrap 依赖，不依赖同级包的构建后导出。构建后执行使用包内 `process.js` 入口。无法映射 Host bootstrap 的执行世界需要预先安装兼容的 `bootstrapPath`；不会假设 Host 路径对应同一个远程文件。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、解析、策略、绑定与受管执行 |
| [`src/launch.ts`](src/launch.ts) | 可执行文件／bootstrap 参数与执行世界资源映射 |
| [`src/process.ts`](src/process.ts) | 子进程握手、环境清空与程序生命周期 |
| [`src/bootstrap.ts`](src/bootstrap.ts) | 程序求值、绑定代理与输出捕获 |
| [`src/channel.ts`](src/channel.ts) | 分帧、有界写入与协议失败 |
| [`src/output-ledger.ts`](src/output-ledger.ts) | Host 外层结果计量 |
| — | 不发布运行时不变式配套模块；分帧与进程清理跨进程边界强制执行，不依靠同进程中的独立观测。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

直接使用提供方前先读服务约定；决策记录解释策略与消费方职责。

- [PTC 运行时服务](../ptc-runtime/README.zh.md)——请求、已解析 spec 与结果。
- [沙箱 Node 决策](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md)——安全、生命周期与 timeout 取舍。
- [PTC 基础](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)——注册表呈现与嵌套工具分派。
- [子进程提供方](../../subprocess/subprocess-local/README.zh.md)——受管进程范围与平台限制。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tools` 的 PTC 模式与 `dsh-workflow-ptc` 间接提供；它们通过各自的工具结果呈现程序结果。中间绑定通信不进入模型历史；外层结果遵循普通工具溢出策略。

#### KV Cache effect

不直接失效；具名消费方负责请求前缀的任何变更。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定执行保证与保留的输出。

- **约束继承所选后端的限制**——完整与部分强制能力分开报告；沙箱策略与受管进程约束是不同保证。
- **堆上限不是进程树内存限制**——原生分配与后代进程内存不属于 V8 老生代上限。不提供进程树 CPU 计量器。
- **清理继承子进程的可观测范围**——使用 fallback 的平台上，逃逸的后代可能仍在受管范围之外；参见子进程提供方声明的限制。
- **执行是一次性的**——没有 yield/wait API、实时结果流或跨调用保留的程序状态。
- **输出上限拒绝超量内容，而不保留每个字节**——溢出只能保存本提供方交付的有界结果。
- **绑定在传输接纳时受限**——控制限制不约束 Host 绑定生成结果期间分配的内存。
- **console shim 有五个方法**——`log`、`info`、`warn`、`error` 与 `debug`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

[timeout 讨论](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md#deferred-timeout-design)记录 yield、总生命周期、审批等待计时和进程树 CPU/RSS 上限的开放选择。这些选择不改变数值截止的默认值或显式的不设截止服务选项。

</details>
