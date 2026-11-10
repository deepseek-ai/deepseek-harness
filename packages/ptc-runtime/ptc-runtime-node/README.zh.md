---
description: "在 Node 进程中运行 TypeScript 程序，可选择保留内存，使用会话文件系统沙箱与可配置的执行限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime-node

[English](README.md) | 中文

## 概述

执行模型编写的 TypeScript，并提供宿主异步函数。默认的 `per-call` 模式在全新 Node 进程中运行异步函数体；`vm-script` 支持顶层 await，并可通过 `scriptPersistence` 为每个 Agent 保留 context。显式启用的 `persistent-in-memory` 为每个 Agent 保留 REPL。所有模式都在进程启动时应用文件沙箱策略，返回捕获日志、无损 JSON 或结构化失败。执行时限、输出上限和 V8 堆上限约束运行。未确认的停止请求与单次执行完成后清理受管进程范围；约束不可用时执行失败。

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

程序通过顶层 `inspect(...values)` 展示文本、对象与 `Image`；同一次调用可混合多段文本和多张图片，图片也可嵌入数组或对象。`Image.attachmentId` 与模型收到的图片说明中的附件 ID 一致。`Image.path` 是执行环境可读取的已存储附件文件，`width` 与 `height` 为该文件的像素尺寸。图片元数据与文本共用 `maxOutputBytes` 预算。

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
    stopGraceMs: 3000
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
| `stopGraceMs` | `3,000` | 终止进程前等待协作式停止确认的时间 |
| `graceMs` | `3,000` | 受管终止与输出排空宽限时间 |
| `launch` | 本地载体 | 子进程环境中显式的 `{ kind: "node-script", executable, bootstrapPath? }` 或 `{ kind: "embedded", executable }` |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-ptc-runtime-node)定义可接受的配置字段。`resolve(request)` 将 cwd 默认设为沙箱策略的工作区根目录，并补全数值或 null 截止选择与执行策略；`run(spec)` 接受这些已解析输入，不补缺省值。

profile 编辑器可从 `@deepseek-ai/dsh-ptc-runtime-node/configuration` 导入 `resolvePersistentExecution`，根据当前有效程序格式选择持久执行设置。返回的两个设置必须原子合入：Script 保留原语法，函数体切换为 REPL。

### 执行与结果

`per-call` 模式中的程序是异步函数体：支持顶层 `await` 与 `return`，且只接受可擦除 TypeScript。Node 全局变量仍然可用，函数体可声明局部 `process`，例如 `const process = await import("node:process")`。成功调用以 `result.value` 返回无损 JSON 值，以 `result.output` 按顺序返回捕获的文本和图片。`result.sandbox` 独立于程序结果报告所选模式、观察到的拒绝，以及后端完整或部分的强制能力。

`inspect(...values)` 直接渲染字符串，其他值使用 Node 的 `util.inspect` 格式，不限制预览深度、数组项数或字符串长度。undefined 属性、Error 对象和循环引用均会展示。注册的 Image 可以直接输出，也可以在 Node 格式化嵌套值时输出，包括 Map 条目、Set 的值以及可枚举的 Symbol 属性。自定义 inspect 方法决定会访问哪些嵌套值。文本和所选图片在共享输出预算内遵循参数顺序。如果对象格式化抛错，此前 inspect 的参数仍然可见。每个文本输出组以换行结尾，原始流写入则保留实际文本。

所有执行模式都提供完整的 Node 原生 console，其 stdout 和 stderr 写入会进入捕获输出。模型指引要求：“使用 inspect(...values) 展示输出，不要使用 console。”

`run_code` 设置 `discardCompletion: true`：函数返回值和末尾表达式的值不经过 JSON 序列化，也不出现在结果中，显式 inspect 的输出仍然可见。直接调用运行时的消费方在未设置此选项时，仍可取得原有的无损 JSON 完成值。

直接文件系统、网络与子进程操作仍是 Node 操作，受所选 OS 沙箱约束。嵌套 Host 绑定通过控制通道调用；PTC 工具调用保留注册表的可见性、排序、日志和审批规则。运行程序不会改变 Session 的常设策略，也不会在拒绝后自动重放程序。

设置 `executionMode: vm-script`，即可通过 `node:vm` Script 求值可擦除 TypeScript。支持顶层声明和 `await`，例如 `var fs = await import("node:fs/promises"); inspect(await fs.readdir("."))`。不支持顶层 `return` 和静态 `import`/`export`。运行时等待末尾表达式；未启用 `discardCompletion` 时，返回其无损 JSON 值。相对动态导入以传入的工作目录为基准解析。除非程序显式启用严格模式，否则 Script 使用非严格语法；context 不是安全边界，Node 访问仍受进程沙箱约束。

`scriptPersistence: false` 是默认值：每次调用都使用全新进程和 context，忽略 `stateOwner`。设为 `true` 后，运行时按下述生命周期规则为每个所有者保留 context。顶层声明、函数与对象身份可供后续调用使用，包括通过顶层 `await` 初始化的值。函数局部变量仍只在函数内有效。该选项要求 `executionMode: vm-script`；两种设置接受相同语法。

```yaml
- id: ptc-runtime
  config:
    executionMode: vm-script
    scriptPersistence: true
```

<a id="persistent-repl"></a>
### 内存保留模式

`persistent-in-memory` 模式和启用 `scriptPersistence: true` 的 Script 模式都按所有者保留状态。要选择 REPL 求值器，在现有 `@deepseek-ai/dsh-ptc-runtime-node` 插件上设置 `executionMode: persistent-in-memory`。所有模式都需要 `fs`、`subprocess`、`sandbox` 和 `sandboxPolicy`，并在进程启动时应用文件沙箱策略。通过配置档补丁显式启用：

```yaml
- id: ptc-runtime
  config:
    executionMode: persistent-in-memory
```

保存补丁，在使用 PTC 工具展示的配置中通过 `dsh headless --patch <path>` 加载。`per-call` 模式和 `scriptPersistence: false` 的 Script 模式不跨调用保留程序内存。修改配置会重载提供方并释放其执行资源。单文件打包宿主默认使用内嵌载体；宿主在每次执行中发送所选的程序格式和保留标志，因此内嵌的 `process.js` bootstrap 同时服务单次执行和保留执行。远端脚本部署使用 `node-script` 启动方式，并将 `launch.bootstrapPath` 指向本包构建出的 `persistent-process.js`。

在 REPL 模式下，每个存活 Agent 保留独立进程，跨 `run_code` 调用和轮次保留顶层变量、函数及导入模块。使用 `await import(...)` 和 `inspect(...)`；不支持顶层 `return`。Node REPL 使用非严格模式，给未声明的名称赋值会创建保留的全局变量。`_` 和 `_error` 是普通的保留全局变量，不使用交互式 REPL 的结果设置器。声明遵循 Node REPL 规则，包括重复声明已有 `let`、`const` 或 `class` 名称时报错；应给可变绑定赋值或选择新名称。开头的 `{ ... }` 按语句块执行，可以包含顶层 await 和临时声明；需要返回对象表达式时，用圆括号包裹。保留的函数和工具方法引用调用当前执行的绑定。必须等待所有工具调用；已完成执行的回调不能在后续执行中调用工具。

在 `persistent-in-memory` 模式下，于运行时首次接纳运行前调用 `registerEnvironmentInitializer(program)`，注册在每个新环境中只执行一次的 REPL 源码。运行时先安装本次绑定，再独立于用户程序求值初始化；二者共享首次调用的截止时间、取消和输出上限。初始化的完成值会被丢弃，打印输出加入结果。新所有者、无所有者执行，以及释放或进程丢失后的运行会创建新环境并再次执行初始化；普通调用复用已初始化的状态。给已初始化的全局变量赋值不会触发初始化。初始化行不会偏移用户程序的位置。其他模式会拒绝注册。

初始化期间的错误、取消、超时或捕获输出超限会阻止用户程序启动，并在返回前终止该环境。此前的外部效果仍然保留。Host 确认初始化完成后，用户程序失败遵循下方的普通状态保留规则。[运行时服务](../ptc-runtime/README.zh.md#choose-a-backend)定义注册和异步注销行为。

内存按尽力保留处理，不保存到磁盘。重启、Agent 销毁、提供方卸载、协议失败、输出超限或进程退出都会清除内存。缺失变量产生普通引用错误，模型需要重新获取句柄和创建声明。当前执行中的异常只结算一次，并保留此前发生的修改。在 REPL 模式下，已完成执行的回调抛出的异常不会在后续结果中报告。在 Script 模式下，未捕获的回调异常可能终止保留进程；结束执行前应等待异步工作完成。Session 仍记录程序、工具分派和可见结果；恢复 Session 或派生 Agent 时从空内存开始。每次执行都会将进程工作目录重置为本次解析的 cwd；程序中的 `process.chdir()` 不跨执行保留。直接 Node 访问遵循进程启动时的文件策略。保留状态的所有者必须先释放环境，才能更改权限模式、工作区根目录或 Session 身份。额外可写目录在进程启动时固定：之后的授权和撤销仅在释放并重新创建环境后生效。

服务消费者通过 `stateOwner` 对象复用环境，并在结束时等待 `release(owner)`。没有所有者的请求在临时进程中执行。此类执行失败不影响其他所有者保留的变量，也不报告清空了这些变量。权限设置同步记录新模式。Session 模式变化时，运行时立即禁止复用受影响的进程并开始取消，包括空闲环境。下一次程序执行前等待这些进程清理；清理失败会阻止本次程序启动，并允许重试。权限设置成功时，旧进程可能仍在停止过程中。单次获准的提权使用独立环境，返回前等待清理；该次执行无法访问原环境的变量，也不会保留新声明。执行及必要清理完成之前，同一所有者的并发调用会被拒绝；不同所有者可以并发。空闲环境没有过期计时器，进程保留到释放或失败为止。原始 stdout/stderr 不携带执行标识：执行期间收到的字节计入本次输出预算，包括较早启动的子进程此时写出的内容；空闲期间丢弃 stdout，只保留限额内的 stderr 诊断尾部。结束本次执行前，应等待子进程完成。进程退出诊断包含退出码和保留的 stderr 尾部；空闲期间的失败写入宿主日志。清理期间无法观测进程范围时，释放所有者会重试终止；清理成功前拒绝新执行。确认进程退出后仍未排空的管道会产生诊断，但不阻止释放环境。

### 截止时间与取消

对于携带 Session 策略的调用，模式变化会取消其准入，即使调用仍在等待清理或进程启动。恢复先前的模式不会重新启用已取消的调用。

PTC 消费方按 [dsh-tool-executor-ptc](../../core/tool-executor-ptc/README.zh.md) 的说明公开逐次超时与经审批的沙箱选择。运行时只读 `timeout` 描述符向该消费方报告有效默认值与上限。提供方通过 `executionInstructions` 负责求值语法、输出方式和状态保留指引。工具消费者将对应模式的规则附加到面向模型的 schema，不根据 `programFormat` 推断是否保留状态。

省略 `timeoutMs` 使用配置的经过时间默认值；数值请求经过验证并封顶。服务调用方可以显式传入 `timeoutMs: null` 来省略经过时间定时器，工作流适配器即如此；`run_code` 仍只接受正数覆盖值。启用的截止覆盖运行时准备和执行，包括等待嵌套工具或审批的时间。它不是 CPU 计量器。超时结果保留已捕获的输出；在程序提交给就绪进程之前报告 `execution timed out before code started`，提交后报告 `execution timed out during execution`。保留环境中的执行超时或取消会请求协作式撤销。发出停止请求后产生的捕获输出会被丢弃，包括 `catch` 和 `finally` 处理器的捕获输出。收到确认后保留 VM 和变量，包括此前发生的修改。如果执行线程未在 `stopGraceMs` 内确认，或确认失败，宿主终止受管进程范围并等待清理。结果仍为 `timeout` 或 `abort`，并说明变量被保留还是清空；超时消息还会报告经过时间预算。确认终止后，下一次调用创建空环境。清理失败返回 `worker-exit`，并阻止复用，直到宿主释放成功。启动前超时、临时执行停止以及逐次执行成功完成均立即终止受管进程范围。选择结果后、清理前停止计时器，因此调用可能要在执行截止之后等待清理结算才返回。

### 失败

程序解析错误与抛出异常为 `exception`；截止到期为 `timeout`；取消为 `abort`；无法解析或超量的控制通信以及无效的程序消息为 `protocol`；约束不可用为 `sandbox-unavailable`；进程提前退出、控制通道丢失或受管清理失败为 `worker-exit`。控制通道 I/O 失败时，在观测到的进程退出状态之外保留通道诊断原因。进程提供方保留与执行基底无关的失败名 `worker-exit`。捕获完成值时，有损值为 `invalid-output`，外层结果超限为 `output-limit`，并在诊断之外保留预算内有序的图文前缀。无效或不支持的选项，以及资源释放后的调用，以调用方误用拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Host 负责策略、截止时间、绑定查找和进程清理。子进程负责程序求值与绑定代理；即使使用预期的控制描述符，模型编写的代码仍是不可信对端。

`createExecution()` 在提供方加载时一次性确定配置对应的语法、类型擦除、模型指导和进程生命周期。提供方处理执行准入与取消。统一的执行所有者创建临时进程，或在启用状态保留时复用所有者的进程；二者都由 `ProgramWorker` 负责启动、截止时间、绑定分派和清理。共用的子进程循环根据本次执行数据选择 `createProgramEvaluator()`；异步函数、REPL 和 Script 实现提供全局变量、求值与清理操作，与进程生命周期独立。运行时等待初始化求值结束，不等待或展开其完成值；随后等待 Host 确认，再执行用户程序。求值器报告完成时立即结算用户程序；随后运行的微任务不能再输出内容或调用绑定。REPL 诊断也可以结算当前运行。

### 启动与控制

Host 擦除可擦除类型；需要启动进程时，在配置的执行世界中解析可执行文件与 bootstrap，通过 `ctx.sandbox` 等待 argv 限制准备完成，再通过 `ctx.subprocess` 启动。限制准备完成后会再次检查取消状态，因此提供方在取消后返回也无法启动程序。接管继承的控制通道后，子进程在 OS 环境中只保留可执行文件搜索路径、Windows 系统路径和临时路径，并将程序可见的 `process.env` 替换为空字典。`node:process` 的具名导出同步更新，因此导入也会获得空环境。Windows ACL 初始化接收父进程各自的 `TEMP` 和 `TMP` 值以使用共享授权锁，然后在启动程序前将二者替换为私有目录。这些原生路径使嵌套进程创建和原生临时文件 API 仍可正常工作。Host 仅在子进程启动时保留 `ELECTRON_RUN_AS_NODE`，使桌面端可执行文件运行 Node bootstrap；bootstrap 在求值模型代码前删除该选择变量。堆上限通过 Node argv 或为打包可执行文件由提供方构造的 `NODE_OPTIONS` 值传递；环境中的加载器和调试器标志会被丢弃。

控制通信使用继承管道上的逐行 JSON，与 stdout/stderr 分离。RPC 适配层限制每条消息和原生写入队列的大小，在通道关闭时拒绝待完成的传输调用，关闭后不再执行方法。不支持的方法会收到错误回复。Host 在分派前校验绑定名称和无损 JSON。

Host 通过有序控制管道上的 birpc 调用子进程的 `run()`。同一时间只运行一次执行，其异步上下文阻止已结束执行的回调发起新绑定或发送捕获输出。RPC 请求将执行完成结果和绑定回复关联到各自的调用方。新环境在用户代码启动前通过需要确认的 `initialized()` RPC 完成初始化；Host 仅在首次运行仍处于活动状态时接受该调用，子进程收到回复后再次检查取消状态。初始化完成后发生超时或取消时，Host 拒绝新绑定调用及迟到结果，发送单向 `revoke()` 通知，并在 `stopGraceMs` 内等待原 `run()` 响应。撤销会让未完成的工具调用正常抛错，允许用户的 `catch` 和 `finally` 运行。有效响应确认本次执行已结束，不改变已选定的超时或取消结果。未收到响应、请求被拒绝或响应格式无效时，终止进程。调用方必须等待执行结束，或兜底终止及清理完成后，才能开始下一次执行。阻塞的事件循环无法处理撤销，因此同步死循环需要终止进程并丢失保留状态。

定时器、任意用户创建的 Promise、I/O 回调、Worker 和子进程不承诺按执行取消。停止确认仅等待当前执行结束，不表示这些资源已清理。未受管异步工作在确认停止后仍可能修改保留的全局变量；已结束执行的捕获输出和完成通知会被忽略。返回前应等待必要工作完成，资源不可信时使用宿主重置。

单次执行完成后，尚未完成的绑定等待保持挂起，并停止绑定调用和捕获输出的通知。子进程保持控制管道打开，直到 Host 收到结果并关闭管道。输出捕获计量序列化日志加完成值或诊断；固定结果信封字段与沙箱元数据不计入该账本。

### 源代码与构建后 bootstrap

源代码执行加载仅含可擦除语法的 bootstrap 依赖，不依赖同级包的构建后导出；执行世界中必须提供求值器模块和已安装的 Acorn 与 birpc 依赖。构建后脚本对所有模式使用 `process.js`；`persistent-process.js` 委托同一个循环，并为未指定程序语法的宿主提供 REPL 默认值。内嵌载体通过 `launch.executable` 启动私有 worker，并在每次执行中携带程序格式和保留标志。远端脚本部署提供对应的 `launch.bootstrapPath`。`resolveLaunch()` 在构造时选择本地默认值；显式的远端调用不依赖客户端自身是否打包。不会假设 Host 路径对应同一个远程文件。

包含 `await` 的源码会在原生编译前检查顶层 await，否则原生编译可能将 `await` 当作标识符。Acorn 解析包住源码的异步函数，acorn-walk 沿用 Node REPL 的 visitor、声明提升和按字符位置修改源码的方式进行遍历。类方法的计算属性名参与遍历，方法体仍独立求值。转换包装末尾表达式，求值器解包并等待其值。无需转换的源码使用原生编译；不含 `await` 的提交保留原生语法诊断。语法错误保留解析器消息、可用的源码位置与光标，不包含编译器或转换器的调用帧。动态 `import()` 表达式保持原生形式，使用编译该 Script 时的 `importModuleDynamically` 选项。两个私有进程 bundle 都包含 Acorn、acorn-walk 和 birpc；源码执行导入已安装的包。

<a id="runner-import-handling"></a>
### Runner 导入处理

Runner 代码可以向 `runNodeMain()` 或 `runPersistentMain()` 传入 `ProgramImportHandler`。handler 属于子进程，与执行语法无关；它不是序列化的 Host 绑定或插件配置字段。VM Script 接受同步或异步决策；AsyncFunction 和 Node REPL 要求同步决策，返回 Promise 时会被拒绝。`node-script` 和 embedded 启动方式启用 `--experimental-vm-modules`；独立启动的 runner 在拦截 VM Script 导入时需要该标志。AsyncFunction 和 REPL 导入拦截不需要 VM 启动标志。

handler 接收程序的动态导入；在 VM Script 中，还接收 VM 加载的 ESM 依赖中的静态与动态导入。每个请求携带模块标识符、导入属性和实际导入文件的绝对文件名。即使 cwd 改变，保存的函数仍保留该文件名。可返回的决策包括：

- `{ type: 'default' }` 解析并加载请求的模块。
- `{ type: 'redirect', specifier }` 使用原始属性解析并加载替换后的模块标识符。
- `{ type: 'module', exports }` 将自有、可枚举的字符串属性暴露为模块导出，包括名为 `default` 的属性。

默认导入和重定向导入相对于实际导入文件解析；替换后的模块标识符不会再次进入 handler。VM Script 使用 Node ESM 解析器，沿用 runner 当前启用的条件和标志，通过 `SourceTextModule` 在 Script context 内加载 `.mjs` 文件以及 Node 解析结果标记为 `module` 的 `.js` 文件。其静态依赖、再导出和稍后的动态导入都调用同一个支持异步决策的 handler。每个求值器按解析后的 URL 缓存文件模块，包括模块与 handler 失败；静态导入只绑定一次。若模块的链接或求值因先前求值结束而失败，后续求值会重新加载该模块，成功求值的模块仍保留身份。模块保留 `import.meta.url`、`filename`、`dirname`、`resolve()` 和 `main: false`。其他格式使用 Node 加载器；未提供 handler 时，所有导入也使用 Node 加载器。handler 抛出值或拒绝会使导入该依赖的模块图失败，不会回退；无关模块图仍可使用。VM Script 在调用 handler 前拒绝 source 阶段导入，并拒绝 VM 加载的 ESM 上的导入属性。AsyncFunction 和 Node REPL 保留 Node 原生依赖加载与 source 阶段规则。

导出值可以是 runner 内的任意对象：原型、私有字段、闭包、循环引用和同步方法都保持正常行为。一个 exports 对象在每个求值器中标识一个模块；名称和值只捕获一次，引用的对象仍可修改。返回不同的 exports 对象会创建另一个模块。每次动态导入以及链接时的每个静态请求都会调用 handler。模块求值失败也会针对该 exports 对象缓存。可调用的 `then` 导出在 AsyncFunction 和 VM Script 中遵循 JavaScript 动态导入的 Promise 同化规则；Node REPL 会拒绝由此产生的非模块值，因此在 REPL 中需使用其他导出名。

AsyncFunction 和 Node REPL 共用同步 `registerHooks` 和以 symbol 为键的全局导出桥接对象。经 VM 编译的工厂使用 Node 默认加载器调用原生 AsyncFunction 构造器，保留严格模式函数体语法和参数绑定。每个求值器与编译文件名组合使用独立的 source URL，确保 V8 构造器缓存保留正确的 import handler 和 referrer。REPL 使用 `AsyncLocalStorage` 区分共享 Node 基于 cwd 生成的导入 URL 的求值器。VM Script 通过逐模块回调管理 ESM 加载与链接；Node 保留求值状态。清理时释放求值器缓存，并移除 hook 和桥接对象；Node 会将原生加载的 ESM 命名空间和 symbol 注册表键保留到进程退出。保留模式求值结束后才发起或返回结果的导入会被拒绝；临时求值让这些导入保持挂起，直到进程退出。保存的函数在后续活动求值中调用时可以正常导入。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Node 提供方：统一执行准入、取消与服务委托 |
| [`src/config.ts`](src/config.ts) | 执行模式、限制校验与默认值 |
| [`src/configuration.ts`](src/configuration.ts) | 供 profile 编辑器使用的持久执行设置 |
| [`src/execution.ts`](src/execution.ts) | 模式选择、请求解析及临时或保留进程的所有权 |
| [`src/worker.ts`](src/worker.ts) | 共用的进程启动、执行截止与绑定分派；`interruptEvaluation()` 请求协作中断，`terminate()` 终止进程 |
| [`src/persistent-process.ts`](src/persistent-process.ts) | 默认使用 REPL 的已安装入口，委托共用子进程循环 |
| [`src/evaluators/index.ts`](src/evaluators/index.ts) | 三种求值器的统一选择入口 |
| [`src/imports/vm-modules.ts`](src/imports/vm-modules.ts) | Script 导入决策、递归 ESM 链接与原生加载委托 |
| [`src/imports/module-hooks.ts`](src/imports/module-hooks.ts) | AsyncFunction 和 REPL hook、求值器归属与导出桥接对象 |
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

- **递归导入处理覆盖显式声明的文件 ESM**——CommonJS、推断为 ESM 的文件、TypeScript、data URL 和其他原生加载格式保留各自的依赖加载器。静态导入原生模块时，在求值时捕获合成导出；动态原生导入保留原始命名空间。VM 加载的 ESM 实例与 Node 原生模块缓存独立，共享 Script 全局变量。
- **约束继承所选后端的限制**——完整与部分强制能力分开报告；沙箱策略与受管进程约束是不同保证。
- **堆上限不是进程树内存限制**——原生分配与后代进程内存不属于 V8 老生代上限。不提供进程树 CPU 计量器。
- **清理继承子进程的可观测范围**——使用 fallback 的平台上，逃逸的后代可能仍在受管范围之外；参见子进程提供方声明的限制。
- **默认执行是一次性的**：保留状态需要设置 `persistent-in-memory` 模式，或在 Script 模式下启用 `scriptPersistence: true`；所有模式都不提供 yield/wait API。
- **await 转换放宽声明语义**——转换后程序的顶层 `let`、`const` 和 `class` 绑定可修改，且在执行前初始化为 `undefined`，不再具有原生暂时性死区。执行到函数声明时才会为其设置保留的全局变量；没有初始化器的 `var` 声明会将其绑定重置为 `undefined`。直接 eval 中的声明仅在本次求值内有效。不接受顶层 `using` 声明；可释放绑定需放在块内。运行时堆栈位置指向转换后的源码。无需转换即可编译的脚本保持原生语义。
- **原生词法初始化失败可能占用名称**——顶层 `let`、`const` 或 `class` 的初始化器在完成绑定初始化前抛错时，该名称会在保留的 Script context 中持续处于未初始化状态。读取、赋值和重新声明都会失败；应使用新名称，或释放并重新创建环境。
- **Script 值可能跨 realm**——绑定结果、绑定拒绝类和导入模块可能使用 Script context 之外的构造器。这些值的 `instanceof Array` 或 `instanceof Error` 可能为 false；应使用 `Array.isArray` 和声明的绑定错误类。
- **内存保留环境为每个存活所有者保留一个进程**——空闲所有者保留进程及堆内存，直到显式释放、所有者销毁或执行失败。并行创建多个所有者会保留多个进程；空闲过期机制留待后续处理。
- **输出上限拒绝超量内容，而不保留每个字节**——溢出只能保存本提供方交付的有界结果。
- **格式化先分配内存再核算输出**——完整格式化对象和 TypedArray 所需的内存可能远大于保留的输出。输出预算不限制这些临时分配；耗尽配置的堆上限可能以 `worker-exit` 结束执行。
- **绑定在传输接纳时受限**——控制限制不约束 Host 绑定生成结果期间分配的内存。
- **预装 bootstrap 需要兼容的协议版本**——就绪握手会在派发代码前拒绝缺失或不匹配的版本。请将 `launch.bootstrapPath` 与宿主一同升级；运行时不会安装远端 bootstrap 更新。
- **图片引用随进程保留**——每张已获取图片的宿主元数据保留到进程终止或所有者释放，包括程序尚未展示的图片。保留环境中的长截图循环会累积这些引用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

[timeout 讨论](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md#deferred-timeout-design)记录 yield、总生命周期、审批等待计时和进程树 CPU/RSS 上限的开放选择。这些选择不改变数值截止的默认值或显式的不设截止服务选项。

</details>
