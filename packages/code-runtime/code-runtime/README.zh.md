---
description: "抽象代码执行 seam（`ctx.codeRuntime`），供用户与维护者组合、消费或构建后端，以针对宿主提供的绑定运行一段模型编写的程序。"
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime

[English](README.md) | 中文

## 概述

`dsh-code-runtime` 定义代码运行时做什么：针对一组宿主提供的异步函数运行一段模型编写的程序，并报告 `{ value, logs, error? }`——不规定任何后端如何实现。在组合中与一个后端一起加载它，服务即可作为 `ctx.codeRuntime` 使用；随后 `dsh-tools` 中的 PTC mode 即可运行组合工具的模型程序。每次请求只运行一次，运行之间不保留状态；每个程序结果——包括失败——都以结果字段 resolve，而不是 reject。运行时不了解工具或会话：调用方只向它提供程序与具名绑定，所有与工具有关的内容都留在 Consumer。

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

当你要组合一个执行模型程序的部署、直接消费 `ctx.codeRuntime`，或构建运行程序的后端时，选择本包。在已发布的组合中，`dsh-tools` 里的 PTC mode 是消费方：只有程序打印和返回的内容重新进入对话。

### 运行一个程序

向运行时提供程序源码与一个或多个绑定命名空间。每个命名空间会成为程序内的一个全局异步函数对象——PTC mode 在 `tools` 下传入一个。程序作为异步函数的函数体运行，因此顶层 `await`／`return` 可用；无损 JSON 完成值成为 `result.value`，每个输出通道在 `result.logs` 中保留自身顺序而跨通道交错由后端决定，任何失败都以 `result.error` 报告并带有可分支的 kind。运行时绝不会因程序失败而 reject——reject 意味着你误用了 seam，例如在 dispose（资源释放）后提交运行。

```text
const result = await ctx.codeRuntime.run({
  program: 'return await tools.add({ a: 1, b: 2 })',
  bindings: [{ global: 'tools', functions: { add: async (args) => args.a + args.b } }],
})
// result.value === 3
```

### 选择后端

后端声明两个你可以依赖的描述符：`language`——程序必须使用的源语言，已知值为 `'typescript'` 与 `'python'`——以及 `isolation`——执行基底（`'worker-thread'`、`'process'`、`'container'`），仅供部署与诊断使用，不构成安全声明。[`dsh-code-runtime-worker-thread`](../code-runtime-worker-thread/README.zh.md) 在全新的 Node Worker 线程中执行 TypeScript；私有的 [`dsh-experimental-code-runtime-python`](../../experimental/code-runtime-python/README.zh.md) 包在全新的 CPython 子进程中执行 Python，供选择性组合使用。

### 可移植地命名绑定

binding-global 与 error-class 名称是语言可移植的：必须匹配 `[A-Za-z_][A-Za-z0-9_]*`，避开每个可移植目标语言的保留字，并避开后端拥有的槽位，因此同一份命名空间列表对每个后端都有效。`$tools`、`lambda` 或 `console` 之类的名称会在运行开始前失败；确切的排除集是 seam 约定的一部分。

### 可能出什么问题

失败以 `result.error` 返回，并带正交的 `kind`：程序抛出或解析失败（`exception`）、预算到期（`timeout`）、运行被中止（`abort`）、执行基底终止（`worker-exit`）、完成值不是无损 JSON（`invalid-output`），或序列化输出超过上限（`output-limit`）。每种 kind 都带一条可反馈给模型的消息。`run()` 只在 seam 误用时 reject，例如在 dispose 后提交运行，或绑定名称不符合可移植标识符规则。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 seam 背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包是代码执行能力 seam 的 Service Definition 角色（[能力 seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）：一个注册为 `ctx.codeRuntime` 的抽象 `CodeRuntime extends Service`，加上两个后端与消费方共享的词汇。提供方继承 `CodeRuntime`、实现 `run` 并注册服务；消费方（`dsh-tools` 中的 PTC mode）生成面向模型的 SDK 并桥接工具分发。按约定，运行时不了解工具与会话：它接收程序与具名异步绑定，返回 `{ value, logs, error? }`。

### 服务 API

约定是后端实现的三个成员：`run(request)` 针对请求的绑定执行一段程序，并把每个程序结果——解析／转换失败、抛出异常、无效完成值、输出溢出、预算到期、中止或基底终止——都作为结果 `error` 字段 resolve，reject 只留给调用方误用，例如在 dispose 后提交运行；`language` 与 `isolation` 是只读描述符，为部署与诊断标注源语言与执行基底。

穷尽式语义见[代码运行时子系统参考](../../../docs/subsystems/code-runtime.zh.md)；确切签名见 [`src/index.ts`](src/index.ts)。

### 词汇

`CodeRunRequest`（`program`、`bindings`、`signal?`）携带运行时操作所需的全部内容；默认值（时间预算、输出上限）来自各提供方的已验证配置，绝不是 `run()` 内部隐藏的 `??`。`bindings` 是 `CodeBindingNamespace` 列表（`global` + `functions` + 可选 `errorClass`），每个命名空间作为程序内的一个全局异步可调用函数对象公开，返回 `CodeJsonValue`——seam 的结构性无损 JSON 类型。`errorClass` 描述符点名真实的程序全局构造器，以及用于接收被拒绝成员名称的自有属性，因此后端永远不会得知 `ToolCallError` 之类的 Consumer 术语。`CodeRunResult` 报告无损 JSON 完成值 `value?`、通道内有序且跨通道交错由后端决定的 `logs: string[]`，以及 `error?`（`CodeRunFailure`：正交 `kind` + 可反馈给模型的 `message`）。完整约定见 `src/types.ts`。

### 可移植标识符

binding-global 与 error-class 名称是语言可移植的：必须匹配标识符子集 `[A-Za-z_][A-Za-z0-9_]*`（不含 JS 专有的 `$`）并通过 seam 导出的排除集，因此同一份 `bindings` 列表对每个后端都有效。本包导出每个后端都执行的约定——`PORTABLE_RESERVED_WORDS`（ECMAScript ∪ Python 保留字）、`RESERVED_BINDING_GLOBALS`（如 `console`、`__dsh_main__` 等后端拥有的 global）、`RESERVED_ERROR_MEMBERS` 与 `DUNDER_MEMBER`（error-member 排除）——因此 `$tools`、`lambda` 或 `__dsh_main__` 之类的名称会让 `run()` 在任何后端上作为 seam 误用而 reject。确切集合见 `src/index.ts`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `CodeRuntime` 服务与可移植标识符排除集 |
| [`src/types.ts`](src/types.ts) | 词汇：`CodeRunRequest`、`CodeBindingNamespace`、`CodeJsonValue`、`CodeRunResult`、`CodeRunFailure` |
| — | 不发布运行时不变式伴生入口；seam 不注册任何可变数据关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下内容。它们从 PTC mode 消费方进入后端与能力 seam 模型。

- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)——工具注册表如何消费 `ctx.codeRuntime` 并把 `run_code` 呈现给模型。
- [Worker 线程后端](../code-runtime-worker-thread/README.zh.md)——已发布的 TypeScript 执行后端。
- [实验性 Python 后端](../../experimental/code-runtime-python/README.zh.md)——私有的 CPython 子进程提供方及其 fd-3 协议。
- [代码运行时子系统参考](../../../docs/subsystems/code-runtime.zh.md)——请求／结果词汇、绑定与 `ctx.codeRuntime` 的 cordis 接口面。
- [能力 seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)——Service Definition / Service Provider / Consumer 拆分。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tools` 中的 PTC mode 间接提供；后者公开 `run_code`，并将程序日志、值或失败作为保留的工具结果 token 返回。

#### KV Cache 影响

不会直接失效；由上述消费方负责请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 seam 不能做什么；它们是当前包约束，不是任务积压。

- **`run()` 是一次性的**——`logs` 只有在 `CodeRunResult` resolve 后才能获得；seam 不提供正在运行的程序所产生输出的流式日志或进度接口。
- **运行之间不保留状态**——每次请求都在全新环境中运行；持久 REPL 风格内核在某个后端带来自己的日志方案之前保持延期。
- **worker 线程后端已发布；Python process 后端是私有实验包；`'container'` 没有实现**——强安全边界需要等待容器后端。
- **中间 binding 值没有字节上限**——实现仍受 structured-clone 成本与进程内存约束，而提供方或执行器可能已经应用自己的获取上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的方向与开放问题。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

#### 未来：持久内核后端

跨 `run_code` 调用保留状态的 REPL 风格内核仍未决定；它需要自己的日志方案，因为「运行之间不保留状态」的约定正是让每次请求仅凭会话日志即可重建的原因。

#### 未来：容器后端

容器级后端将为代码与 shell 执行都提供硬性的多租户边界；除已知的 `isolation` 值外，暂无任何决定。

</details>
