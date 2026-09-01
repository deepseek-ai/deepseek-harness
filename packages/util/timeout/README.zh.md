---
description: "共享超时运算、截止时间融合与超时/取消分类，供需要限制调用方提示、启动 deadline 并在之后区分二者的能力使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-timeout

[English](README.md) | 中文

## 概述

`dsh-timeout` 让能力在调用方可见的超时下运行一个工作单元，之后能把超时与取消区分开。调用方的可选提示会按后端默认值补齐、并按后端上限封顶，上游取消与截止时间融合为一个 `AbortSignal`。deadline 信号只负责通知——停止工作的机制由各能力自己拥有，因此没有任何共享层需要知道如何停止任何东西。对于流式传输，空闲 watchdog 只在提供方读取尚未完成时启动超时，因此消费方的思考时间绝不计入空闲。`timeoutMs` 为 0 是后端自有后台工作使用的内部「无超时」哨兵值，绝不是公开的禁用开关；这个零依赖库由 bash、web、subprocess 与 tool-timeout-policy 消费方共享。

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

当能力要在调用方可见的超时下运行一个工作单元时使用 `deadline`，读取流式传输时使用 `idleWatchdog`。先用 `clampTimeout` 验证调用方提示，确保到达 `deadline` 的 `timeoutMs` 总是正有限值。

### 限制超时提示

```ts
import { clampTimeout } from '@deepseek-ai/dsh-timeout'

declare const requested: number | undefined
declare const DEFAULT_TIMEOUT_MS: number
declare const MAX_TIMEOUT_MS: number

const timeoutMs = clampTimeout(requested, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'bash-local: request.timeoutMs')
```

提示缺失时 `clampTimeout` 填入后端默认值，把结果限制在后端最大值以内，并以调用方提供的名字拒绝非正数或非有限值的提示。此处绝不接受 0：它不是公开的禁用超时值。

### 在 deadline 下运行工作

```text
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

using d = deadline(upstream, timeoutMs, 'BASH_TIMEOUT')
const outcome = await runWork({ signal: d.signal })   // work listens on d.signal and terminates itself
const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
const aborted = d.signal.aborted && !timedOut
```

该信号只负责通知：调用方必须接入自己的终止机制——把 `d.signal` 传给 `fetch`，或监听 `abort` 并杀死子进程。让 promise 与 timer 竞速，会在子进程或套接字仍在泄漏时就让工具调用完成。

### 分类结果

只有当本 deadline 的 timer 先触发时，`timeoutOf(signal, code)` 才恢复超时原因。传入你自己的 `code`，让分类在嵌套场景中正确组合：当 `upstream` 本身是 deadline 信号时，外部超时会被当作普通的上游取消，而不是声称本地 timer 已到期。

### 用空闲 watchdog 处理流式传输

```ts
import { idleWatchdog } from '@deepseek-ai/dsh-timeout'

declare const upstream: AbortSignal | undefined
declare const idleMs: number
declare const providerIterator: AsyncIterator<unknown>

using watchdog = idleWatchdog(upstream, idleMs, 'LLM_STREAM_IDLE_TIMEOUT')
const next = await watchdog.next(providerIterator)    // timer runs only while this read is outstanding
```

timer 只在某个迭代器 `next()` 尚未完成时启动，并会因不产生值的传输活动通过 `pulse()` 重新启动，因此读取之间的消费方思考时间绝不计入空闲。间隔必须为正有限数，且不得大于 `MAX_TIMER_DELAY_MS`。

### 哪些操作不设置超时

本地文件 `read`/`write`/`edit` 不接受 `timeoutMs`：文件 IO 不设时限地运行，因为截止时间会中止操作系统仍会完成的工作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本库建立在一个边界之上：共享时序与分类，把强制终止保留在本地。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `clampTimeout`、`deadline`、`idleWatchdog`、`timeoutOf`、`TimeoutReason`、`MAX_TIMER_DELAY_MS` |
| — | 不发布运行时不变式伴生入口；时序运算由单元测试覆盖。 |

### deadline 如何融合来源

`deadline` 启动一个 timer，并通过 `AbortSignal.any` 把它与上游信号融合；`AbortSignal.any` 采纳最先中止的来源的原因，因此竞争会归结为单一原因。`TimeoutReason` 携带能力自有的 `code` 与已流逝的 `timeoutMs`；只有当超时胜出时 `timeoutOf` 才读取它，上游胜出则保留普通的中止原因。`[Symbol.dispose]` 清除 timer。

### 无超时哨兵值

`timeoutMs <= 0` 不启动 timer，只转发上游信号——没有上游时返回永不中止的信号——因此每个调用方都保持同一种调用形态。该哨兵值服务于后端自有后台工作；外部请求提示在到达 `deadline` 之前先被验证为正有限值。

### 空闲 watchdog 为何重新启动

`idleWatchdog` 保持一个稳定的融合信号，只在 `next()` 尚未完成时启动 timer；完成后停止，后续需求或 `pulse()` 重新启动，dispose（资源释放）时清除，并发需求被拒绝。只有传输层观察该信号，因此提供方的真实读取必须监听它——DeepSeek 与 pi-ai 适配器会在中止时关闭响应正文或 SDK 请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要消费方或库背后的边界决策时，阅读以下页面。

- [超时 deadline 库 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——共享时序、本地强制终止的边界。
- [工具调用超时策略](../../guard/timeout-policy/README.zh.md)——强制执行已声明工具超时的消费方。
- [bash 提供方](../../shell/bash-local/README.zh.md)——杀死进程组的前台 deadline 消费方。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——本地文件 IO 为何不设时限。

-----

<a id="model-experience"></a>
## 模型体验

通过渲染超时结果的超时消费方间接影响模型。

#### KV Cache 影响

不会直接导致失效；请求前缀的任何变更由超时消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本库刻意不做什么。它们是当前包约束，不是任务积压。

- **只发出通知**——deadline 无法停止忽略其信号的工作；每项能力仍需要自己的 socket、进程或任务终止路径。
- **`timeoutMs <= 0` 是内部词汇**——只有在所属后端已解析策略后，它才会禁用本地 timer；绝不会作为面向模型或插件的公开开关。
- **第一个中止原因决定分类**——当上游取消早于本地 timer 发生时，即使自己的超时之后也会到期，该层也无法再报告。
- **空闲 watchdog 不是总 deadline**——它针对每个尚未完成的迭代器需求重新启动，并刻意排除消费方的思考时间。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
