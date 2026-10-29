---
description: "在 Node 进程中运行 TypeScript 程序，可选择保留内存，使用会话文件系统沙箱与可配置的执行限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime-node

[English](README.md) | 中文

## 概述

执行模型编写的 TypeScript，并提供宿主异步函数。默认的 `per-call` 模式在全新 Node 进程中运行异步函数体；`vm-script` 支持顶层 await，并可通过 `scriptPersistence` 为每个 Agent 保留 context。显式启用的 `persistent-in-memory` 为每个 Agent 保留 REPL。所有模式都应用所选文件沙箱策略，返回捕获日志、无损 JSON 或结构化失败。执行时限、输出上限和 V8 堆上限约束运行。取消与单次执行完成后清理受管进程范围；约束不可用时执行失败。

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

在提供 `fs`、`subprocess`、`sandbox` 和 `sandboxPolicy` 的组合中挂载本提供方。`dsh-tool-executor-ptc`传入调用 Session 的目录和常设策略；直接运行时消费方在执行前解析这些选项。

### 配置

在所需服务可用后，配置提供方条目：

```yaml
- name: '@deepseek-ai/dsh-ptc-runtime-node'
  config:
    executionMode: per-call
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
| `executionMode` | `per-call` | `per-call` 在全新进程中运行异步函数体；`vm-script` 求值 Script；`persistent-in-memory` 为每个所有者保留受限 REPL |
| `scriptPersistence` | `false` | 在 `executionMode: vm-script` 下，为每个所有者复用进程与 context；其他模式下设为 `true` 会在加载时拒绝 |
| `timeoutMs` | `120,000` | 默认经过时间截止，包括嵌套工具与审批等待 |
| `maxTimeoutMs` | `600,000` | 解析器应用的经过时间截止上限 |
| `maxOutputBytes` | `67,108,864` | 序列化日志与完成值或诊断的合计预算 |
| `maxOldGenerationSizeMb` | `512` | V8 老生代堆上限，单位 MiB |
| `maxMessageBytes` | `134,217,728` | 控制消息、未完成绑定参数字节和排队控制写入的上限 |
| `maxPendingCalls` | `128` | 同时进行的 Host 绑定调用数量上限 |
| `graceMs` | `3,000` | 受管终止与输出排空宽限时间 |
| `launch` | 本地载体 | 子进程环境中显式的 `{ kind: "node-script", executable, bootstrapPath? }` 或 `{ kind: "embedded", executable }` |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-ptc-runtime-node)定义可接受的配置字段。`resolve(request)` 将 cwd 默认设为沙箱策略的工作区根目录，并补全数值或 null 截止选择与执行策略；`run(spec)` 接受这些已解析输入，不补缺省值。

profile 编辑器可从 `@deepseek-ai/dsh-ptc-runtime-node/configuration` 导入 `resolvePersistentExecution`，根据当前有效程序格式选择持久执行设置。返回的两个设置必须原子合入：Script 保留原语法，函数体切换为 REPL。

### 执行与结果

`per-call` 模式中的程序是异步函数体：支持顶层 `await` 与 `return`，且只接受可擦除 TypeScript。Node 全局变量仍然可用，函数体可声明局部 `process`，例如 `const process = await import("node:process")`。成功调用以 `result.value` 返回无损 JSON 值，以 `result.logs` 返回捕获文本。`result.sandbox` 独立于程序结果报告所选模式、观察到的拒绝，以及后端完整或部分的强制能力。

直接文件系统、网络与子进程操作仍是 Node 操作，受所选 OS 沙箱约束。嵌套 Host 绑定通过控制通道调用；PTC 工具调用保留注册表的可见性、排序、日志和审批规则。运行程序不会改变 Session 的常设策略，也不会在拒绝后自动重放程序。

设置 `executionMode: vm-script`，即可通过 `node:vm` Script 求值可擦除 TypeScript。支持顶层声明和 `await`，例如 `var fs = await import("node:fs/promises"); await fs.readdir(".")`。不支持顶层 `return` 和静态 `import`/`export`。运行时等待末尾表达式，并返回其无损 JSON 值；`console.log(...)` 也会产生输出。相对动态导入以传入的工作目录为基准解析。除非程序显式启用严格模式，否则 Script 使用非严格语法；context 不是安全边界，Node 访问仍受进程沙箱约束。

`scriptPersistence: false` 是默认值：每次调用都使用全新进程和 context，忽略 `stateOwner`。设为 `true` 后，运行时按下述生命周期规则为每个所有者保留 context。顶层声明、函数与对象身份可供后续调用使用，包括通过顶层 `await` 初始化的值。函数局部变量仍只在函数内有效。该选项要求 `executionMode: vm-script`；两种设置接受相同语法。

```yaml
- id: ptc-runtime
  config:
    executionMode: vm-script
    scriptPersistence: true
```

<a id="persistent-repl"></a>
### 内存保留模式

`persistent-in-memory` 模式和启用 `scriptPersistence: true` 的 Script 模式都按所有者保留状态。要选择 REPL 求值器，在现有 `@deepseek-ai/dsh-ptc-runtime-node` 插件上设置 `executionMode: persistent-in-memory`。所有模式都需要 `fs`、`subprocess`、`sandbox` 和 `sandboxPolicy`，并应用所选文件沙箱策略。通过配置档补丁显式启用：

```yaml
- id: ptc-runtime
  config:
    executionMode: persistent-in-memory
```

保存补丁，在使用 PTC 工具展示的配置中通过 `dsh headless --patch <path>` 加载。`per-call` 模式和 `scriptPersistence: false` 的 Script 模式不跨调用保留程序内存。修改配置会重载提供方并释放其执行资源。单文件打包宿主使用内存保留模式时，需要使用 `node-script` 启动方式，将 `launch.executable` 指向 Node，并将 `launch.bootstrapPath` 指向本包构建出的 `process.js`。

在 REPL 模式下，每个存活 Agent 保留独立进程，跨 `run_code` 调用和轮次保留顶层变量、函数及导入模块。使用 `await import(...)`、`console.log(...)` 和末尾 JSON 表达式；不支持顶层 `return`。Node REPL 使用非严格模式，给未声明的名称赋值会创建保留的全局变量。`_` 和 `_error` 是普通的保留全局变量，不使用交互式 REPL 的结果设置器。声明遵循 Node REPL 规则，包括重复声明已有 `let`、`const` 或 `class` 名称时报错；应给可变绑定赋值或选择新名称。开头的 `{ ... }` 按语句块执行，可以包含顶层 await 和临时声明；需要返回对象表达式时，用圆括号包裹。保留的函数和工具方法引用调用当前执行的绑定。必须等待所有工具调用；已完成执行的回调不能在后续执行中调用工具。

内存按尽力保留处理，不保存到磁盘。重启、Agent 销毁、提供方卸载、取消、超时、协议失败、输出超限或进程退出都会清除内存。缺失变量产生普通引用错误，模型需要重新获取句柄和创建声明。当前执行中的异常只结算一次，并保留此前发生的修改。在 REPL 模式下，已完成执行的回调抛出的异常不会在后续结果中报告。在 Script 模式下，未捕获的回调异常可能终止保留进程；结束执行前应等待异步工作完成。Session 仍记录程序、工具分派和可见结果；恢复 Session 或派生 Agent 时从空内存开始。每次执行都会将进程工作目录重置为本次解析的 cwd；程序中的 `process.chdir()` 不跨执行保留。直接 Node 访问遵循已解析的文件策略。保留状态的所有者必须先释放环境，才能更改权限模式、工作区根目录、额外可写根目录或 Session 身份。

服务消费者通过 `stateOwner` 对象复用环境，并在结束时等待 `release(owner)`。没有所有者的请求在临时进程中执行。此类执行失败不影响其他所有者保留的变量，也不报告清空了这些变量。权限设置同步记录新模式。Session 模式变化时，运行时立即禁止复用受影响的进程并开始取消，包括空闲环境。下一次程序执行前等待这些进程清理；清理失败会阻止本次程序启动，并允许重试。权限设置成功时，旧进程可能仍在停止过程中。单次获准的提权使用独立环境，返回前等待清理；该次执行无法访问原环境的变量，也不会保留新声明。执行及必要清理完成之前，同一所有者的并发调用会被拒绝；不同所有者可以并发。空闲环境没有过期计时器，进程保留到释放或失败为止。原始 stdout/stderr 不携带执行标识：执行期间收到的字节计入本次输出预算，包括较早启动的子进程此时写出的内容；空闲期间丢弃 stdout，只保留限额内的 stderr 诊断尾部。结束本次执行前，应等待子进程完成。进程退出诊断包含退出码和保留的 stderr 尾部；空闲期间的失败写入宿主日志。清理期间无法观测进程范围时，释放所有者会重试终止；清理成功前拒绝新执行。确认进程退出后仍未排空的管道会产生诊断，但不阻止释放环境。

### 截止时间与取消

对于携带 Session 策略的调用，模式变化会取消其准入，即使调用仍在等待清理或进程启动。恢复先前的模式不会重新启用已取消的调用。

PTC 消费方按 [dsh-tool-executor-ptc](../../core/tool-executor-ptc/README.zh.md) 的说明公开逐次超时与经审批的沙箱选择。运行时只读 `timeout` 描述符向该消费方报告有效默认值与上限。提供方通过 `executionInstructions` 负责求值语法、输出方式和状态保留指引。工具消费者将对应模式的规则附加到面向模型的 schema，不根据 `programFormat` 推断是否保留状态。

省略 `timeoutMs` 使用配置的经过时间默认值；数值请求经过验证并封顶。服务调用方可以显式传入 `timeoutMs: null` 来省略经过时间定时器，工作流适配器即如此；`run_code` 仍只接受正数覆盖值。启用的截止覆盖运行时准备和执行，包括等待嵌套工具或审批的时间。它不是 CPU 计量器。超时或取消通过 Host 的受管进程所有者停止同步循环；逐次执行成功完成也会清理该受管范围。选择结果后、清理前停止计时器，因此调用可能要在执行截止之后等待清理结算才返回。

### 失败

程序解析错误与抛出异常为 `exception`；截止到期为 `timeout`；取消为 `abort`；无法解析或超量的控制通信以及无效的程序消息为 `protocol`；约束不可用为 `sandbox-unavailable`；进程提前退出、控制通道丢失或受管清理失败为 `worker-exit`。控制通道 I/O 失败时，在观测到的进程退出状态之外保留通道诊断原因。进程提供方保留与执行基底无关的失败名 `worker-exit`。有损完成值为 `invalid-output`，外层结果超限为 `output-limit`，并保留能容纳的日志前缀。无效或不支持的选项，以及资源释放后的调用，以调用方误用拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Host 负责策略、截止时间、绑定查找和进程清理。子进程负责程序求值与绑定代理；即使使用预期的控制描述符，模型编写的代码仍是不可信对端。

`createExecution()` 在提供方加载时一次性确定配置对应的语法、类型擦除、模型指导和进程生命周期。提供方处理执行准入与取消。统一的执行所有者创建临时进程，或在启用状态保留时复用所有者的进程；二者都由 `ProgramWorker` 负责启动、截止时间、绑定分派和清理。共用的子进程循环根据本次执行数据选择 `createProgramEvaluator()`；异步函数、REPL 和 Script 实现提供全局变量、求值与清理操作，与进程生命周期独立。

### 启动与控制

Host 擦除可擦除类型；需要启动进程时，在配置的执行世界中解析可执行文件与 bootstrap，通过 `ctx.sandbox` 等待 argv 限制准备完成，再通过 `ctx.subprocess` 启动。限制准备完成后会再次检查取消状态，因此提供方在取消后返回也无法启动程序。接管继承的控制通道后，子进程在 OS 环境中只保留可执行文件搜索路径、Windows 系统路径和临时路径，并将程序可见的 `process.env` 替换为空字典。Windows ACL 初始化接收父进程各自的 `TEMP` 和 `TMP` 值以使用共享授权锁，然后在启动程序前将二者替换为私有目录。这些原生路径使嵌套进程创建和原生临时文件 API 仍可正常工作。Host 仅在子进程启动时保留 `ELECTRON_RUN_AS_NODE`，使桌面端可执行文件运行 Node bootstrap；bootstrap 在求值模型代码前删除该选择变量。堆上限通过 Node argv 或为打包可执行文件由提供方构造的 `NODE_OPTIONS` 值传递；环境中的加载器和调试器标志会被丢弃。

Host 通过 birpc 调用子进程的 `run()` 方法；注入的绑定调用 Host 的 `invoke()` 方法，捕获的输出通过通知传递。birpc 负责请求关联、远程结果和异常传递。逐行 JSON 通过继承的控制管道传输，与 stdout/stderr 分离。RPC 适配层限制每行消息和原生写入队列的大小，并在管道关闭时拒绝待完成调用；对端点自身没有的方法，birpc 以错误回复，管道关闭后不再执行任何方法。Host 在分派前校验绑定名与无损 JSON；同一管道保证每次求值的消息先于其结果到达，因此消息不携带求值身份。执行截止时间仍由 Host 管理，包含等待审批的调用。

单次执行完成后，尚未完成的绑定等待保持挂起，并停止绑定调用和捕获输出的通知。子进程保持控制管道打开，直到 Host 收到结果并关闭管道。输出捕获计量序列化日志加完成值或诊断；固定结果信封字段与沙箱元数据不计入该账本。

### 源代码与构建后 bootstrap

源代码执行加载仅含可擦除语法的 bootstrap 依赖，不依赖同级包的构建后导出；执行世界中必须提供求值器模块和已安装的 Acorn、birpc 依赖。构建后脚本在所有模式下都使用 `process.js`；`persistent-process.js` 委托同一个循环，供未指定程序语法的宿主默认使用 REPL。保留模式要求 `node-script` 启动方式。远端脚本部署提供对应的 `launch.bootstrapPath`。内嵌载体通过 `launch.executable` 启动私有 worker。`resolveLaunch()` 在构造时选择本地默认值；显式的远端调用不依赖客户端自身是否打包。不会假设 Host 路径对应同一个远程文件。

包含 `await` 的源码会在原生编译前检查顶层 await，否则原生编译可能将 `await` 当作标识符。Acorn 解析包住源码的异步函数，acorn-walk 沿用 Node REPL 的 visitor、声明提升和按字符位置修改源码的方式进行遍历。类方法的计算属性名参与遍历，方法体仍独立求值。转换包装末尾表达式，求值器解包并等待其值。无需转换的源码使用原生编译；不含 `await` 的提交保留原生语法诊断。语法错误保留解析器消息、可用的源码位置与光标，不包含编译器或转换器的调用帧。动态 `import()` 表达式保持原生形式，使用编译该 Script 时的 `importModuleDynamically` 选项。两个私有进程 bundle 都包含 Acorn、acorn-walk 和 birpc；源码执行导入已安装的包。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Node 提供方：统一执行准入、取消与服务委托 |
| [`src/config.ts`](src/config.ts) | 执行模式、限制校验与默认值 |
| [`src/configuration.ts`](src/configuration.ts) | 供 profile 编辑器使用的持久执行设置 |
| [`src/execution.ts`](src/execution.ts) | 模式选择、请求解析及临时或保留进程的所有权 |
| [`src/worker.ts`](src/worker.ts) | 共用的进程启动、执行截止、绑定分派与清理 |
| [`src/persistent-process.ts`](src/persistent-process.ts) | 默认使用 REPL 的已安装入口，委托共用子进程循环 |
| [`src/evaluators/index.ts`](src/evaluators/index.ts) | 三种求值器的统一选择入口 |
| [`src/evaluators/async-function.ts`](src/evaluators/async-function.ts) | AsyncFunction：严格模式异步函数体 |
| [`src/evaluators/repl.ts`](src/evaluators/repl.ts) | Node REPL：交互式声明与保留的 context |
| [`src/evaluators/vm-script.ts`](src/evaluators/vm-script.ts) | VM Script：Node 全局变量、声明与 Promise 完成值 |
| [`src/evaluators/vm-script-await.ts`](src/evaluators/vm-script-await.ts) | VM Script 的顶层 await 转换与声明保留 |
| [`src/output-stream.ts`](src/output-stream.ts) | 有界流捕获与进程输出排空 |
| [`src/launch.ts`](src/launch.ts) | 可执行文件／bootstrap 参数与执行世界资源映射 |
| [`src/process.ts`](src/process.ts) | 共用的子进程握手、求值器生命周期与绑定 RPC |
| [`src/bootstrap.ts`](src/bootstrap.ts) | 绑定代理、JSON 校验、跨 realm 异常格式化与输出捕获 |
| [`src/rpc.ts`](src/rpc.ts) | 类型化 birpc 传输、消息限制与连接生命周期 |
| [`src/protocol.ts`](src/protocol.ts) | Host 与程序方法，以及不可信程序结果的校验 |
| [`src/output-ledger.ts`](src/output-ledger.ts) | Host 外层结果计量 |

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

通过 `dsh-tool-executor-ptc`与 `dsh-workflow-ptc` 间接提供；它们通过各自的工具结果呈现程序结果。中间绑定通信不进入模型历史；外层结果遵循普通工具溢出策略。

#### KV Cache effect

不直接失效；具名消费方负责请求前缀的任何变更。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定执行保证与保留的输出。

- **约束继承所选后端的限制**——完整与部分强制能力分开报告；沙箱策略与受管进程约束是不同保证。
- **堆上限不是进程树内存限制**——原生分配与后代进程内存不属于 V8 老生代上限。不提供进程树 CPU 计量器。
- **清理继承子进程的可观测范围**——使用 fallback 的平台上，逃逸的后代可能仍在受管范围之外；参见子进程提供方声明的限制。
- **默认执行是一次性的**：保留状态需要设置 `persistent-in-memory` 模式，或在 Script 模式下启用 `scriptPersistence: true`；所有模式都不提供 yield/wait API。
- **await 转换放宽声明语义**——转换后程序的顶层 `let`、`const` 和 `class` 绑定可修改，且在执行前初始化为 `undefined`，不再具有原生暂时性死区。执行到函数声明时才会为其设置保留的全局变量；没有初始化器的 `var` 声明会将其绑定重置为 `undefined`。直接 eval 中的声明仅在本次求值内有效。不接受顶层 `using` 声明；可释放绑定需放在块内。运行时堆栈位置指向转换后的源码。无需转换即可编译的脚本保持原生语义。
- **原生词法初始化失败可能占用名称**——顶层 `let`、`const` 或 `class` 的初始化器在完成绑定初始化前抛错时，该名称会在保留的 Script context 中持续处于未初始化状态。读取、赋值和重新声明都会失败；应使用新名称，或释放并重新创建环境。
- **Script 值可能跨 realm**——绑定结果、绑定拒绝类和导入模块可能使用 Script context 之外的构造器。这些值的 `instanceof Array` 或 `instanceof Error` 可能为 false；应使用 `Array.isArray` 和声明的绑定错误类。
- **内存保留环境为每个存活所有者保留一个进程**——空闲所有者保留进程及堆内存，直到显式释放、所有者销毁或执行失败。并行创建多个所有者会保留多个进程；空闲过期机制留待后续处理。
- **输出上限拒绝超量内容，而不保留每个字节**——溢出只能保存本提供方交付的有界结果。
- **绑定在传输接纳时受限**——控制限制不约束 Host 绑定生成结果期间分配的内存。
- **控制协议没有版本握手**——预装的 `launch.bootstrapPath` 或 SSH helper 必须来自与客户端相同的版本；其他版本的 bootstrap 会在第一条控制消息时失败。
- **console shim 有五个方法**——`log`、`info`、`warn`、`error` 与 `debug`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

[timeout 讨论](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md#deferred-timeout-design)记录 yield、总生命周期、审批等待计时和进程树 CPU/RSS 上限的开放选择。这些选择不改变数值截止的默认值或显式的不设截止服务选项。

</details>
