---
description: "Worker 线程代码执行，供用户与维护者组合、调优或排查这个已发布的 TypeScript 后端——它在全新的 Node worker 中运行每个程序。"
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-worker-thread

[English](README.md) | 中文

## 概述

`dsh-code-runtime-worker-thread` 为 [`dsh-code-runtime`](../code-runtime/README.zh.md) seam 执行 TypeScript 程序：每个程序都在一个全新的 Node Worker 线程中运行，宿主提供的绑定可作为普通异步函数调用，运行返回 `{ value, logs, error? }`。它是 `dsh-tools` 中 PTC mode 的已发布后端，因此挂载它正是让模型编写的 TypeScript 执行在组合中生效的方式。运行时「包含」程序，但不隔离它：信任立场与 bash 等价，并带有空环境、堆上限、实测忙碌时间与墙钟预算，以及强制终止。程序每次请求只运行一次，运行之间不保留状态；每个失败——语法错误、预算到期、中止、OOM 退出或输出溢出——都以结果字段返回。

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

当组合需要执行模型编写的 TypeScript 程序时，连同 code-runtime seam 一起挂载此后端；只要模型调用 `run_code`，`dsh-tools` 中的 PTC mode 就会通过 `ctx.codeRuntime` 驱动它。每个执行上限都是已验证的配置，因此你可以从 `cordis.yml` 为部署调整运行时规模。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-code-runtime'
- name: '@deepseek-ai/dsh-code-runtime-worker-thread'
  config:
    computeMs: 60000            # busy-time budget (measured event-loop active time)
    maxWallMs: 600000           # wall-clock ceiling; never pauses for anything
    maxOutputBytes: 67108864    # combined serialized outer-output cap (64 MiB)
    maxOldGenerationSizeMb: 512 # worker heap cap
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `computeMs` | `60,000` | 忙碌时间预算：worker 实测事件循环活跃时间超过该值时，运行以 `timeout` 失败 |
| `maxWallMs` | `600,000` | 墙钟上限，为忙碌时间无法观测的等待兜底；最大 `2_147_483_647` |
| `maxOutputBytes` | `67,108,864` | 序列化日志加完成值或失败消息的硬上限；至少 `4` |
| `maxOldGenerationSizeMb` | `512` | worker 堆上限；溢出会杀死 worker，并以 `worker-exit` 呈现 |

每个字段在加载时都会验证并提供默认值；没有其他可调项。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-code-runtime-worker-thread)是每个受支持字段的穷尽式真源。

### 运行返回什么

成功的运行把程序的无损 JSON 完成值作为 `result.value` 返回，把程序打印的文本按顺序作为 `result.logs` 返回。顶层 `await`／`return` 可用，程序可以把宿主提供的绑定函数（PTC mode 暴露一个 `tools` 对象）当作普通异步调用。

### 包含而非安全边界

程序运行时的权限与 bash 工具相当：它可以访问 Node API，后端也刻意不承诺与宿主的隔离。它提供的是包含——独立 isolate、空环境（没有环境变量凭据，也不继承 loader 标志）、可配置堆上限，以及也能终止同步热循环的强制终止。程序派生的 OS 进程在 `terminate()` 后仍然存活，需要部署层面的清理。

### 可能出什么问题

每个程序结果都以结果 resolve，因此失败的运行是 `result.error`，而不是 rejection：语法错误或不可擦除的 TypeScript（`enum`、namespace）在任何 worker 启动前就以 `exception` 失败；预算到期是 `timeout`；中止信号是 `abort`；堆溢出或其他 worker 终止是 `worker-exit`；不是无损 JSON 的完成值是 `invalid-output`；超出上限的序列化输出是 `output-limit`——并保留能容纳的已捕获日志前缀。reject 只表示调用方误用，例如在 dispose（资源释放）后提交运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端建立在一个分离之上：**包含，而非安全边界**。模型代码拥有与 bash 等价的信任（[PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md) 的 Trust posture），因此设计追求可重建性与有界资源使用，而非硬性的多租户边界——那需要等待容器级后端。每次运行使用一个全新的 worker，程序的世界随 worker 一同终止：不存在可泄漏、也无需记录的跨运行状态，仅凭会话日志即可重建一次运行。

### 执行流程

一次运行在宿主侧剥离类型（`node:module` 的 `stripTypeScriptTypes`，保持字节位置不变），包裹为异步函数的函数体使顶层 `await`／`return` 可用，然后发送给全新的 worker，由 bootstrap 物化绑定命名空间。绑定调用以无损 JSON 跨消息端口传递，每个调用 id 至多应答一次。日志文本主动流向宿主，因此被终止的程序仍会显示已打印的内容。恰好一个结果结算运行——`done` 帧、预算到期、中止或 worker 终止——之后宿主终止 worker 并等待其退出。

### 把对端视为不可信

模型代码能够访问 `parentPort` 并伪造通信，因此任何代码读取入站消息前，系统都会逐字段验证并重建：伪造的额外字段绝不随行，非数字的 call id 绝不会被回显进 reply，绑定名称只解析为自有属性（伪造的 `constructor` 无法沿原型链访问），垃圾被静默丢弃。worker 侧命名空间使用 null-prototype，因此形似 `__proto__` 的绑定名称只是普通键。

### 预算

存在两个独立预算，因为对端不可信：`computeMs` 计量 worker 的实测忙碌时间（每 25 ms 轮询一次 `eventLoopUtilization()`），因此热循环无论是否有诱饵 dispatch 在途都会到期，而等待慢绑定的程序不累计；`maxWallMs` 为忙碌时间无法观测的情况兜底，例如永远不会 resolve 的 promise。二者最终都会调用 `worker.terminate()`。`maxWallMs` 在加载时对照 `MAX_TIMER_DELAY_MS` 做范围校验，因为 `setTimeout` 会把更长的延迟限制为 1 ms。

### 输出账本

`maxOutputBytes` 统计外层 `logs` 数组加完成值或失败消息载荷的 JSON 序列化；固定的 `CodeRunResult` 字段名与信封语法不计入这份账本。未超过上限时返回精确值；有损完成值属于 `invalid-output`，组合溢出属于 `output-limit`，不会用 inspected string 代替。失败会保留日志中能容纳的已捕获前缀。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`WorkerThreadCodeRuntime`、运行编排、输出账本 |
| [`src/worker.ts`](src/worker.ts) | 源码模式 worker 入口（可擦除 TypeScript，不依赖 `lib/`） |
| [`src/bootstrap.ts`](src/bootstrap.ts) | worker 侧 bootstrap：命名空间物化、console shim、日志捕获 |
| [`src/protocol.ts`](src/protocol.ts) | host 与 worker 之间的端口消息词汇 |
| [`src/worker-json.ts`](src/worker-json.ts) | worker 侧无损 JSON 编解码 |
| [`src/output-json.ts`](src/output-json.ts) | 外层账本的字节计量与截断 |
| — | 不发布运行时不变式伴生入口；本进程边界实现不暴露可在同一进程内对照的事件关系，worker 协议测试与构建后 worker 测试负责覆盖。 |

### 未构建与已构建的 worker 入口

源代码模式通过 Node 原生类型剥离加载只包含可擦除语法的 `src/worker.ts`；其传递运行时闭包只包含 Node 内置模块和相对源模块，因此全新 checkout 绝不需要兄弟工作区包尚未构建的 `lib/` 导出。构建模式会把兄弟文件 `lib/worker.cjs` 作为文件系统路径传入，因为 pkg 的虚拟文件系统（VFS）Worker hook 要求 CommonJS；同一路径也可在普通 Node 下使用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当后端约定不够用时阅读以下内容。它们从 seam 定义进入消费方与配置面。

- [代码运行时 seam](../code-runtime/README.zh.md)——此后端实现的抽象约定。
- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)——`dsh-tools` 如何消费 `ctx.codeRuntime` 并呈现 `run_code`。
- [代码运行时子系统参考](../../../docs/subsystems/code-runtime.zh.md)——请求／结果词汇、绑定与失败分类体系。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-code-runtime-worker-thread)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tools` 中的 PTC mode 间接提供，如果外层值能容纳则原样渲染，否则返回明确的 `invalid-output`／`output-limit` 失败，且只有外层 `run_code` 结果在其普通落盘策略下进入模型上下文，绑定通信与中间值始终只存在于执行环境中。

#### KV Cache 影响

不会直接失效；由上述消费方负责请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明此后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **程序派生的 OS 进程在程序终止后仍会存活**——`worker.terminate()` 只结束线程，比 bash-local 的进程组终止更弱；在容器后端出现前，孤儿进程清理属于部署职责。
- **类型剥离依赖 Node 的实验性 `stripTypeScriptTypes` API**——如依赖的行为发生变化，amaro 或 sucrase 是已经点名的直接替代品。
- **`computeMs` 到期最多可能超过一个轮询间隔**——系统每 25 ms 采样一次忙碌时间（内部常量，有意不做成配置）。
- **程序获得一个含 5 个方法的 `console` shim**（`log`／`info`／`warn`／`error`／`debug`）——有意不提供 Node 的完整 console 接口。
- **中间绑定值没有字节上限**——程序可以用永远不会成为外层输出的值耗尽进程或 worker 内存。
- **默认 64 MiB 上限是拒绝边界，不是可恢复存储**——外层落盘只能保存发生 `output-limit` 后返回的有界日志和诊断；在运行时上限之外被拒绝的字节永远不会到达落盘层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
