---
description: "CPython 子进程代码 runtime：为 Python 模型代码实现 dsh-code-runtime seam，及其使用的 fd-3 wire 协议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-code-runtime-python

[English](README.md) | 中文

## 概述

`dsh-experimental-code-runtime-python` 提供私有的源码 checkout `PythonCodeRuntime`，即 [`dsh-code-runtime`](../../code-runtime/code-runtime/README.zh.md) seam 的 CPython 子进程实现。它以 `language: 'python'`、`isolation: 'process'` 注册为 `codeRuntime`，每次 `run()` 启动一个全新的 CPython 3.10+ 子进程，把程序作为 async 函数体执行，通过子进程 fd 3 上的无版本 JSON-lines 协议通信（stdout/stderr 留给程序自己的输出）。宿主侧（`src/protocol.ts`）把每条入站帧都视为敌意并逐字段重建后才读取；Python 侧（`py/protocol.py`）镜像消息词汇。隔离（不是安全边界——模型代码与 bash 同等的信任）来自仅含临时目录的环境、`RLIMIT_CPU`/`RLIMIT_AS`、墙钟上限与 `SIGTERM`→宽限→`SIGKILL` 进程组拆卸，所有上限都在插件加载期校验。

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

仅在显式源码检出组合中选择这个私有实验包。将 `PythonCodeRuntime` 与 `dsh-tools` 一起注册后，`run()` 会在全新的 CPython 3.10+ 子进程中执行每个程序；成功时以 `result.value` resolve，失败时以 `result.error` resolve（正交的 `CodeRunFailure.kind` 分类涵盖解析失败、抛出异常、无效完成值、输出溢出、预算到期、中止与执行基底终止）。仅有 seam 误用会 reject——binding 命名空间不合法，或在 dispose 后调用。配置在加载期拒绝：非 Unix 平台；不是可执行普通文件的显式 `pythonBin`，或无法在 `PATH` 上解析的裸名；非 CPython、低于 3.10 或探测失败的解释器；非正或非整数预算；低于截断标记下限（64）的 `maxLogBytes`；会被 `setTimeout` 截断的定时器值；超过有效 fd-3 帧上限的预算（宿主堆无法安全解析接近上限的帧时，该上限会降低）；或最坏峰值会突破 `RLIMIT_AS` 的 `addressSpaceMb`／输出预算组合。

### 你得到什么

包的默认导出是 `PythonCodeRuntime` 插件。其公开面还重新导出宿主侧协议词汇：`validateChildFrame`（重建每条入站帧）、无损 JSON codec 与计量器（`encodeJsonPlain`、`checkDoneValue`、`hasUnsafeIntegerToken`、`hasNonLosslessNumber`）、`logTruncationMarker`（共享截断标记文本），以及 `resolvePythonBin`（对照当前 `PATH` 的解释器查找）、`readProcessStart`（供测试用的进程启动统计）、`detachResidual`（已结算运行的资源清理测试 seam）与 `hostFrameParseCeiling`（给定堆上限可容纳的堆推导帧解析上限）。每个上限都是带默认值并经校验的 `Config` 字段：`cpuSeconds`（60）、`maxWallMs`（600000）、`addressSpaceMb`（512，Darwin 上不生效）、`maxLogBytes`（65536）、`maxValueBytes`（32768）、`graceMs`（3000）与 `pythonBin`（`python3`，在加载期解析、检查可执行性，在五秒强制终止期限内探测版本并固定）。每个子进程只接收 `TMPDIR`；环境中的凭证、`PATH`、`HOME` 与其他宿主状态均不可见。

### wire

帧在子进程 fd 3 上以 JSON-lines 传输——每行一个对象——因此 stdout/stderr 留给程序自己的输出。子进程 → 宿主：`boot-ack`、`call`、`log`、`done`。宿主 → 子进程：`boot`（首帧，携带全部上限与命名空间声明）、`run`（`boot-ack` 之后，只携带程序体）与每个 `call` 一个 `reply`。伪造帧可在 `done` 上同时携带 `value` 与 `error`，因此消费方必须先检查 `error`，在它存在时忽略 `value`。`log` 帧的 `open` 标志标记由显式 flush 提交的未结束行：宿主把下一个 log 帧追加到同一条目，因此 `print('a', end='', flush=True); print('b')` 读回为一条 `'ab'` 条目而不是假换行。合并的唯一例外是截断：当后续超预算帧触发账本时，已计费的前缀作为独立条目先提交，截断 marker 跟在后面（marker 保持末位，无重复计费）。

### 可能出错的地方

宿主侧校验在不抛异常的情况下丢弃垃圾，因此畸形或伪造帧永远不会让宿主进程崩溃：`validateChildFrame` 对任何不能干净重建的内容返回 `undefined`，非数字的 call id 永远不会被回显进 reply，伪造的额外字段永远不会被带走。非无损 JSON 或超过配置字节预算的完成值会被显式拒绝（`non-lossless`／`over-budget`），而不是被静默取整或截断。原始长度超过有效帧解析上限（64 MiB，或当宿主的配置堆无法安全解析接近上限的帧时更低——见 `hostFrameParseCeiling`）的 fd-3 帧会让本次运行以 `worker-exit` 结算（接收路径在 `toString`/`JSON.parse` 之前限制原始帧，紧凑宽帧不能解码出远超其线上字节的宿主内存）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释后端背后的设计；可观察行为在[使用本包](#use-this-package)中完整覆盖。

### 设计概念

单向信任：宿主把每条入站帧都视为敌意（模型代码可以在 fd 3 上伪造任何内容）并逐字段重建后才读取；Python 侧信任宿主回复。bootstrap（`py/bootstrap.py`）把程序作为 async 函数体执行，因此顶层 `await` 与 `return` 都可用；binding 调用经 fd 3 以 JSON-lines 往返，回复在 pump 中限速，以免大量大回复钉住宿主的 fd-3 可写缓冲。

### wire 契约

帧为 `boot`／`run`（宿主 → 子进程）与 `boot-ack`／`call`／`log`／`done` 加每个 call 一个 `reply`（子进程 → 宿主）。`log` 帧的 `truncated` 标志标记的就是子进程账本自己的截断标记帧，因此宿主在与子进程相同的点停止捕获，而不是从自己的预算推断。`log` 帧的 `open` 标志标记由显式 flush 提交的未结束行：宿主把下一个 log 帧合并进同一条目，因此 `print('a', end='', flush=True); print('b')` 读回为一条 `'ab'` 条目而不是假换行（拆分计费算术在 fd-3 协议 Agent Note 的 wire-contract 段）。合并的唯一例外是截断：当后续超预算帧触发账本时，已计费的前缀作为独立条目先提交，截断 marker 跟在后面（marker 保持末位，无重复计费）。`done.error.kind` 为 `exception`、`invalid-output`、`output-limit` 之一；墙钟／CPU 预算、中止与基底死亡在宿主侧观察，不以帧形式携带。

### 无损 JSON 跨越

完成值与 binding 实参以精确 JSON 跨越：值无递归序列化，因此低于字节预算的深层载荷存活，而不会死在 `JSON.stringify` 的栈上限；超出安全范围的整型 double 以精确数字跨越，而不是被静默取整的 token；`src/protocol.ts` 中的计量器在任何其他代码读取载荷之前强制字节预算与数字无损性。

### 镜像对齐

`tests/protocol-mirror.e2e.ts` 启动真实 `python3`，对照 `src/protocol.ts` 断言 `PROTOCOL_FD`／截断标记文本以及 `py/protocol.py` 中每个 `TypedDict` 的必填／可选 wire 字段集，因此字段改名、删除或一侧把另一侧必填的字段变成可选都会使测试失败。字段*类型*不跨语言边界比较；该残留由评审加后端的真实子进程套件（`tests/runtime.spec.ts`）负责。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`PythonCodeRuntime`——spawn、帧 pump、预算、隔离、拆卸；重新导出协议词汇 |
| [`src/protocol.ts`](src/protocol.ts) | 宿主侧：帧 codec、敌意帧校验器、无损 JSON 计量器、共享标记文本 |
| [`py/bootstrap.py`](py/bootstrap.py) | 子进程侧：fd-3 通道、程序执行、binding 分发、账本与结算 |
| [`py/protocol.py`](py/protocol.py) | Python 侧：`PROTOCOL_FD`、`TypedDict` 帧镜像、`log_truncation_marker` |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | 真实子进程套件：预算、隔离、敌意帧、名称重绑 |
| [`tests/protocol-mirror.e2e.ts`](tests/protocol-mirror.e2e.ts) | 对照真实 `python3` 的跨语言镜像测试 |
| — | 不发布运行时不变式伴生入口：帧顺序、预算计量与拆卸发生在 CPython 子进程或 fd 3 上，因此本包没有可供 Cordis listener 比较的同进程事件序列或独立维护的可变关系；协议镜像与真实子进程测试覆盖这些进程边界行为。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 runtime 契约不够时阅读这些。它们从 seam 定义走向设计记录与配套后端。

- [Code runtime seam](../../code-runtime/code-runtime/README.zh.md) — 本后端实现的抽象契约。
- [fd-3 协议 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-31-code-runtime-python-fd3-protocol.zh.md) — 设计理由与 wire 契约。
- [结算修复 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-07-31-code-runtime-python-settlement-fixes.zh.md) — 结算、计量与隔离修复及其回归用例。
- [Worker 线程后端](../../code-runtime/code-runtime-worker-thread/README.zh.md) — 已发布的 TypeScript 兄弟。
- [Code runtime 子系统参考](../../../docs/subsystems/code-runtime.zh.md) — 请求／结果词汇、binding 与失败分类。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tools` 中的 PTC mode；当显式的源码 checkout 组合挂载本提供方时，它会把程序的完成值或失败渲染成保留的 `run_code` 结果，且已发布 profile 均不挂载这个私有包。

#### KV Cache 效应

无直接失效；指定的消费方拥有任何请求前缀变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义本包覆盖与不覆盖的内容；它们是当前包约束，不是任务积压。

- **跨语言 guard 覆盖执行的表面与帧字段形状，而非字段类型**——mirror e2e 比较必填／可选字段集，而非 `cpuSeconds` 在两侧是否都是 `int`；类型级漂移由评审加后端的真实子进程套件捕获。
- **以 `setsid()` 逃出子进程组后代不被组拆卸回收**——`kill(-pid)` 够不到它；运行仍按 done 帧决定的值结算，若该孤儿持有管道，close 截止兜底会强制结算，但孤儿本身在自行退出前一直存活到 fiber 之外。
- **结算后到达的 `log` 帧被丢弃**——运行一旦结算，宿主侧捕获即关闭；迟到的 fd-3 `log` 帧（来自比 done 帧存活更久的线程）会被丢弃，而不是追加到 `logs`。
- **binding 回复值没有 seam 级字节或深度上限**——`maxValueBytes` 只计量 done 帧的完成值；宽 binding 回复在宿主侧重建（`snapshotJsonValue` 遍历）并整帧编码，两侧都只受进程内存约束（与没有子进程侧预算的 binding 实参一样）。
- **已发布 profile 均不挂载本提供方**——keyless `ptc-python-turn` 快照通过真实 Loader 替换 headless PTC 运行时；已发布 profile 继续使用 Worker 线程后端。
- **跨通道日志交错由后端决定**——Python stdout、stderr 与 fd-3 日志帧彼此独立传输；每个通道保留自身顺序，但它们在 `result.logs` 中的总顺序可能不同。
- **需要 CPython 3.10 或更高版本**——配置的可执行文件会在加载期完成解析与版本探测；不受支持的解释器会在 `ctx.codeRuntime` 注册前失败。
- **`run()` 是一次性的**——`logs` 只有在 `CodeRunResult` resolve 后才能获得；没有为运行中程序产生的输出提供流式日志或进度接口。
- **运行之间不保留状态**——每次请求都在全新子进程中执行；持久 REPL 风格内核在某个后端带来自己的日志方案之前保持延期。
- **原始长度超过有效帧解析上限的 fd-3 帧会让本次运行以 worker-exit 结算**——上限为 64 MiB，或当宿主的配置堆无法安全解析接近上限的帧时更低（`hostFrameParseCeiling`）；`maxLogBytes`/`maxValueBytes` 在加载期被限制到同一上限，因此诚实子进程的帧总能放得下；模型构造的超过该上限的 binding 实参（一个在 seam 层没有预算的值）会触发同一上限——这是该 OOM 防护的已接受残余。
- **停止读取回复的子进程会在回复积压超过 1024 帧时以 worker-exit 结算运行**——宿主每次写一条回复，管道满时等待 `drain`；只持续发送调用而不消费回复的子进程会让保留的积压（及其钉住的 binding 结果）一直增长到墙钟，因此积压上限让运行提前失败。binding 结果在 seam 层没有字节上限，所以这是计数上限而非字节上限。
- **向永不结算的 binding 洪泛调用的子进程会在 1024 个调用在途时以 worker-exit 结算运行**——binding 调用在分发前计数、异步体结算时释放，否则 promise 永不 resolve 的 binding 会让每个调用帧累积一个异步闭包直到墙钟。与回复积压一样，这是计数上限而非字节上限。
- **组合日志与值的峰值不被加载门建模**——持续写入的模型 daemon 线程与完成值计量、分帧相加的峰值没有任何门会放行或拒绝；运行以 `worker-exit` 告终，隔离成立，只有失败分类降级。
- **1 秒双限 `ulimit -t 1` CPU 超限被报告为 `worker-exit` 而非 timeout**——当宿主在一个与软限相等的硬 CPU 限下启动且该限为 1 时，`_clamped` 无法下调软限，内核在同一 tick SIGKILL 忙循环，SIGXCPU 永远不会送达；隔离成立，只有分类降级。
- **中间 binding 值没有字节上限**——实现仍受无损 JSON 序列化成本与进程内存约束，提供方或执行器可能应用自己的获取上限。
- **截断标记文本与临时目录前缀保留改名前的短名**——标记 `[dsh-code-runtime-python] log capture truncated at <N> bytes` 与 `dsh-code-runtime-python-` 临时目录前缀被测试逐字节锚定，且独立于 npm 包名；promotion（去掉 `experimental-` 前缀）不会重命名它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
