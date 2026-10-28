---
description: "抽象 PTC 执行 seam（`ctx.ptcRuntime`），供用户与维护者组合、消费或构建后端，以针对宿主提供的绑定运行一段模型编写的程序。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime

[English](README.md) | 中文

## 概述

使用 `dsh-ptc-runtime` 执行调用宿主异步函数的模型程序。请求返回无损 JSON、捕获日志或结构化失败；Promise 拒绝表示调用方误用。提供方隔离不同状态所有者，并声明源码是异步函数体、REPL 语句还是脚本。`retainsState` 报告提供方是否为显式所有者保留内存，直到释放，但不会从 Session 恢复这些内存。语言与隔离描述符标识语法和执行基底，不提供安全保证。

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

当你要组合一个执行模型程序的部署、直接消费 `ctx.ptcRuntime`，或构建运行程序的后端时，选择本包。`dsh-tool-executor-ptc` 用它执行工具程序，`dsh-workflow-ptc` 用它编排工作流。每个消费方负责返回给模型的内容。

### 运行一个程序

传入程序和绑定命名空间，依次调用 `resolve(request)` 和 `run(spec)`。解析阶段验证 cwd、超时与沙盒选项，并应用提供方默认值。`programFormat: PtcProgramFormat` 选择支持顶层 `await`、`return` 的异步函数体，或支持顶层声明、`await` 和末尾表达式的 REPL/Script 语句。Node Script 提供方转换顶层 await 并等待完成值；其[声明限制](../ptc-runtime-node/README.zh.md#known-limitations-and-deferred-work)适用于转换后的程序。无损 JSON 完成值进入 `result.value`，文本进入 `result.logs`，失败进入 `result.error`。

```text
const spec = ctx.ptcRuntime.resolve({
  program: 'return await tools.add({ a: 1, b: 2 })',
  bindings: [{ global: 'tools', functions: { add: async (args) => args.a + args.b } }],
})
const result = await ctx.ptcRuntime.run(spec)
// result.value === 3
```

### 选择后端

后端以 `language` 与 `isolation` 提供诊断描述符；两者都不授予权限或证明约束。[`dsh-ptc-runtime-node`](../ptc-runtime-node/README.zh.md) 在全新的受管 Node 进程中按已解析沙箱策略执行可擦除 TypeScript。私有的 [`dsh-experimental-ptc-runtime-python`](../../experimental/ptc-runtime-python/README.zh.md) 提供方在全新 CPython 子进程中执行 Python，不提供文件约束。`sandboxMode` 声明提供方的部署文件策略模式；不支持该能力时则缺省。

使用可选的[Node 内存保留模式](../ptc-runtime-node/README.zh.md#persistent-repl)时，跨调用传入同一个 `stateOwner` 对象，并在所有者结束时等待 `release(owner)`。不同对象不会共享环境；省略所有者时使用临时环境。无状态提供方忽略所有权。同一保留环境的调用不能重叠。

### 可移植地命名绑定

binding-global 与 error-class 名称是语言可移植的：必须匹配 `[A-Za-z_][A-Za-z0-9_]*`，避开每个可移植目标语言的保留字，并避开后端拥有的槽位，因此同一份命名空间列表对每个后端都有效。`$tools`、`lambda` 或 `console` 之类的名称会在运行开始前失败；确切的排除集是 seam 约定的一部分。

### 可能出什么问题

失败以 `result.error` 返回，带正交的 `kind`：`exception`、`timeout`、`abort`、`worker-exit`、`invalid-output`、`output-limit`、`protocol` 或 `sandbox-unavailable`。提供方在成功或失败之外，单独返回适用的 `result.sandbox` 事实。无效或不支持的执行选项在 `resolve` 期间失败；`run` 拒绝调用方误用，例如未解析输入、无效绑定名或资源释放后的调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 seam 背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包是 PTC 执行能力 seam 的 Service Definition 角色（[能力 seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）：一个注册为 `ctx.ptcRuntime` 的抽象 `PtcRuntime extends Service`，加上提供方与消费方共享的词汇。提供方继承 `PtcRuntime`、实现 `resolve` 和 `run` 并注册服务。`dsh-tool-executor-ptc` 负责工具绑定，`dsh-workflow-ptc` 负责工作流钩子与子 agent。按约定，运行时不了解工具与会话：它接收程序、具名异步绑定和已解析执行选项，然后返回捕获输出、执行结果与适用的沙箱事实。

### 服务 API

只读 `timeout` 描述符公开数值型 `{ defaultMs, maxMs }`，供消费方呈现；描述符缺省表示不支持数值覆盖。省略 `timeoutMs` 使用提供方默认值；数值请求经过验证和封顶的经过时间预算；显式 `null` 请求不设经过时间截止。提供方拒绝不支持的选择。Node 工作流适配器请求 `null`，而面向模型的 `run_code` 工具只接受正数覆盖值。

`executionInstructions` 提供由运行时拥有的使用说明；不需要说明时返回空字符串。消费方可将其纳入程序呈现，无需根据语言或隔离描述符识别提供方；PTC 将它纳入已记录的 `run_code` schema。

`resolve(request)` 负责支持选项的验证与部署默认值。`run(spec)` 执行完整输入，并在清理后返回程序结果。语言和执行基底描述符指导呈现；`sandboxMode` 表示消费方能否传入已解析文件策略。描述符与程序成功结果都不能代替后端报告的强制能力事实。

穷尽式语义见[PTC 运行时子系统参考](../../../docs/subsystems/ptc-runtime.zh.md)；确切签名见 [`src/index.ts`](src/index.ts)。

### 词汇

`PtcRunRequest` 携带程序、Host 绑定、取消和可选执行选择。`PtcRunSpec` 要求已解析的 cwd 和明确的数值或 null 截止选择。`PtcBindingNamespace` 声明程序全局对象与可选的类型化拒绝构造器。`PtcRunResult` 将日志／值、失败与 `PtcRunSandbox` 事实分开；确切字段与提供方义务见 [`src/types.ts`](src/types.ts)。

### 可移植标识符

binding-global 与 error-class 名称是语言可移植的：必须匹配标识符子集 `[A-Za-z_][A-Za-z0-9_]*`（不含 JS 专有的 `$`）并通过 seam 导出的排除集，因此同一份 `bindings` 列表对每个后端都有效。本包导出每个后端都执行的约定——`PORTABLE_RESERVED_WORDS`（ECMAScript ∪ Python 保留字）、`RESERVED_BINDING_GLOBALS`（如 `console`、`__dsh_main__` 等后端拥有的 global）、`RESERVED_ERROR_MEMBERS` 与 `DUNDER_MEMBER`（error-member 排除）——因此 `$tools`、`lambda` 或 `__dsh_main__` 之类的名称会让 `run()` 在任何后端上作为 seam 误用而 reject。确切集合见 `src/index.ts`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `PtcRuntime` 服务与可移植标识符排除集 |
| [`src/types.ts`](src/types.ts) | 词汇：`PtcRunRequest`、`PtcRunSpec`、绑定、结果、失败与沙箱事实 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下内容。它们从 PTC mode 消费方进入后端与能力 seam 模型。

- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)——工具注册表如何消费 `ctx.ptcRuntime` 并把 `run_code` 呈现给模型。
- [Node 进程后端](../ptc-runtime-node/README.zh.md)——已发布的 TypeScript 执行后端。
- [实验性 Python 后端](../../experimental/ptc-runtime-python/README.zh.md)——私有的 CPython 子进程提供方及其 fd-3 协议。
- [PTC 运行时子系统参考](../../../docs/subsystems/ptc-runtime.zh.md)——请求／结果词汇、绑定与 `ctx.ptcRuntime` 的 cordis 接口面。
- [能力 seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)——Service Definition / Service Provider / Consumer 拆分。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-executor-ptc` 与工作流适配器间接提供；它们通过各自的工具结果呈现程序结果。

#### KV Cache 影响

不会直接失效；由上述消费方负责请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 seam 不能做什么；它们是当前包约束，不是任务积压。

- **`run()` 是一次性的**——`logs` 只有在 `PtcRunResult` resolve 后才能获得；seam 不提供正在运行的程序所产生输出的流式日志或进度接口。
- **保留内存可以丢失**：提供方可以为显式所有者保留状态；重启、释放以及提供方指定的失败会清除状态。程序、绑定调用和结果仍由消费者记录；运行中的对象不会被序列化或回放。
- **提供方的约束能力不同**——已发布 Node 提供方强制执行已解析文件策略，私有实验性 Python 提供方拒绝显式策略。不提供容器提供方。
- **提供方之间没有统一的绑定字节上限**——各提供方负责自己的传输限制；绑定仍可能在结果到达这些限制前分配内存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的方向与开放问题。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

#### 保留状态

保留状态没有磁盘检查点或恢复协议。消费者必须容忍状态丢失，并在 Session 日志中记录模型可见的程序与结果。

#### 未来：容器后端

容器级后端将为代码与 shell 执行都提供硬性的多租户边界；除已知的 `isolation` 值外，暂无任何决定。

</details>
