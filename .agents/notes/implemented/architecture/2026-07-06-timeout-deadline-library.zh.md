# Agent Note: 共享的超时/截止时间原语，硬终止留给各能力自行实现

Status: implemented

[English](2026-07-06-timeout-deadline-library.md) | 中文

## 问题

超时处理在各个承载工具的能力之间逐渐分化，而且这种分化并非表面的：同一套逻辑被以三种方式重新实现，各自带有微妙的正确性负担。

- **bash**（当时位于 bash-local 实现的 `run.ts`）在进程管道内部有一套完整、正确的超时实现：一个经配置钳位的 `timeoutMs`，两个独立触发器（用于超时的 `killTimer` 和用于上游取消的 `onAbort` 监听器），各自调用同一个 `kill()` 闭包驱动子进程终止路径，以及两个正交的结果布尔值（`timedOut`、`aborted`）独立锁存。经此次整合之后，这套管道——位于 [packages/subprocess/subprocess-local/src/spawn.ts](../../../../packages/subprocess/subprocess-local/src/spawn.ts)——只响应中止；[packages/shell/bash-local/src/index.ts](../../../../packages/shell/bash-local/src/index.ts) 拥有融合的 deadline 以及 `timedOut`/`aborted` 分类。
- **web_fetch**（[packages/web/web-fetch-http/src/provider.ts](../../../../packages/web/web-fetch-http/src/provider.ts)）有一套正确但*手写*的超时：构造一个 `AbortController`，连接 `setTimeout(() => controller.abort(new WebError(…, 'WEB_FETCH_TIMEOUT')))`，手动添加和移除上游信号监听器，在 `finally` 中清除定时器，并在 `translateAbortOrNetwork` 辅助函数中从 `signal.reason` 恢复超时原因（因为 reader 只抛出裸 `AbortError`）。
- **web_search**（[packages/web/tool-web/src/search.ts](../../../../packages/web/tool-web/src/search.ts)）**完全没有超时**：`WebSearchRequest`（[packages/web/web/src/types.ts](../../../../packages/web/web/src/types.ts)）不携带 `timeoutMs` 字段，各提供方的 `search()` 只转发 `exec.signal`。（web_search 在本次设计中保持无超时——见「后果」。）

每个新的外部进程或网络工具都要重新推导同样四件事：钳位请求值、启动定时器、将超时与上游取消融合、在出口处区分「超时」与「已取消」。而融合与原因恢复恰恰是最容易出微妙错误的部分（web_fetch 的 `signal.reason` 处理就是证据）。与此同时，各能力执行的*终止*操作不可归约地不同：bash 请求其子进程提供方终止由 OS 拥有的范围，而 web 中止一个进程内的 `fetch`，由 undici 拆除 socket。[原生 containment 决策](2026-08-28-subprocess-native-containment.zh.md)负责本地 scope、Job 与 fallback 机制；不存在一个能停止所有能力工作的单一机制。

## 决策

`@deepseek-ai/dsh-timeout` 位于 `packages/util/`（与 `dsh-brand` 同级），负责超时的*计时与分类*这一半；*终止*那一半——硬终止——留在各能力的实现中。它是一个纯函数库，**不是** Cordis 服务或插件：不接收 `ctx`、不注册任何东西、不持有跨调用状态、不发射事件。这里刻意不设中央「超时服务」，因为那样的服务必须知道如何停止每个能力的工作——而这正是微内核要排除在共享层之外的知识，也是 Codex 将 `ExecExpiration` 限定于 exec 族所示范的原则。

### 库的对外接口

四个函数、一个 watchdog 接口加一个 reason 类型：

```ts ignore-check
/** The internal reason attached to a timeout abort, so consumers can classify it after the fact. */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Validate/fill a caller's optional positive hint from the backend's default, then cap at its max. */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number

/**
 * Build a deadline signal that aborts on upstream cancellation OR on timeout,
 * with the timeout carrying a `TimeoutReason`. `timeoutMs <= 0` means "no
 * timeout" (background jobs): forward only the upstream signal, arm no timer.
 * The returned object's `[Symbol.dispose]` clears the timer — `using` for a
 * scope-lifetime consumer, a manual call for an event-lifetime one.
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): { signal: AbortSignal; [Symbol.dispose](): void }

/** A stable signal plus one-at-a-time, timer-guarded async-iterator demand. */
export interface IdleWatchdog {
  readonly signal: AbortSignal
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>
  pulse(): void
  [Symbol.dispose](): void
}

/** Arm only while one iterator `next()` is outstanding; rearm on later demand or out-of-band activity. */
export function idleWatchdog(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): IdleWatchdog

/** Recover the TimeoutReason from an aborted signal (or error); `code` scopes the match to this deadline's timer. */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined
```

`deadline` 通过 `AbortSignal.any` 将上游信号与一次性定时器融合，附加一个类型化的 `TimeoutReason`，并暴露可 dispose（资源释放）的定时器清理。非正数超时是内部的「无超时」哨兵，用于后端拥有的后台任务；外部提示经过 `clampTimeout`，必须为正有限值。既无定时器也无上游信号时，函数返回一个永不中止的信号，具有相同的 disposal 形状。`idleWatchdog` 则要求正有限的间隔，在整个流期间保持一个稳定的融合信号，并且只在一个迭代器 `next()` 尚未结算时启动定时器；结算会解除定时器，后续 demand 会重新启动，带外传输活动发生后，`pulse()` 则会为同一个尚未结算的 demand 重新启动定时器。若没有尚未结算的 demand，或已经 dispose，pulse 不执行任何操作；并发 demand 会失败，dispose 会清除当前 arm。提供方将超时原因转译为 seam 特定的结果。`timeoutOf(signal, code)` 限定分类范围，使外层嵌套的 deadline 被视为上游取消而非内层能力自身的超时。

### 职责划分

| 关注点 | 负责方 |
|---|---|
| 校验请求提示并钳位默认值/最大值 | `dsh-timeout`（`clampTimeout`）：纯算术加共享的正有限请求约定 |
| 启动一次性定时器、到期中止、携带 reason、与上游取消融合 | `dsh-timeout`（`deadline`） |
| 仅围绕未结算的迭代器 demand 启动和重启，带外活动也会触发重启 | `dsh-timeout`（`idleWatchdog`） |
| 清除定时器 | `dsh-timeout`（任一原语的 `[Symbol.dispose]`） |
| 中止后对首个 abort reason 进行分类 | `dsh-timeout`（`timeoutOf`） |
| **实际终止工作** | 各能力的实现 |
| 默认值/最大值*数值* | 各能力的配置 |
| 超时 `code` 字符串 | 各能力（`WEB_FETCH_TIMEOUT` ≠ `BASH_TIMEOUT`） |

信号只*通知*；终止始终是监听方的职责，而监听方因能力而异。bash 自行编写 `addEventListener('abort', kill)`，因为 OS 进程存在于本运行时之外，必须由子进程提供方驱动其拥有的范围达到完全停稳；web 将 `d.signal` 交给 `fetch`，由 undici 拆除 socket。这也是文件读/写/编辑**不接受** `timeoutMs` 的原因：本地系统调用最多只能尽力中止，超时无法强制 `fsync`/`rename` 停止，添加超时将是一个违反「显式优于隐式」的隐式默认值。两个参考 agent（智能体）出于同样的原因对文件 I/O 不设超时。

### 各能力如何消费该库

- **web_fetch**：工具层保持校验并转发；提供方手写的 controller + `setTimeout` + 手动监听器 + `finally` + `signal.reason` 恢复被替换为提供方自有的 `deadline`/`timeoutOf`。已预先中止的上游信号仍然立即抛出 `WEB_ABORTED`；否则 `fetch` 使用融合后的 `d.signal` 运行，`translateAbortOrNetwork` 根据信号分类抛出的错误（`timeoutOf` → `WEB_FETCH_TIMEOUT`，否则已中止 → `WEB_ABORTED`，否则网络错误 → `WEB_PROVIDER_ERROR`）。公开的错误码约定不变，`TimeoutReason` 永远不会作为公开错误跨越 web seam。
- **bash**：`resolve()` 将请求钳位为显式规格。前台 `run()` 创建 deadline 并将其信号传给进程执行，后者的 abort 监听器调用 `SubprocessHandle.terminate()`，并等待同一个由提供方管理的范围。执行器将首个 abort 分类为超时或取消。后台启动保持无超时，仅转发上游取消。
- **LLM（大语言模型）适配器**：`dsh-llm-deepseek` 和 `dsh-llm-pi-ai` 用 `idleWatchdog` 包装实际的传输迭代。配置的五分钟间隔只覆盖尚未结算的提供方 demand，不包括下游消费方在分片之间花费的时间。DeepSeek 直连适配器还会在其 SSE（Server-Sent Events）解析器观察到注释时，对该项尚未结算的 demand 调用 `pulse()`；该注释既不会作为 `StreamChunk` 产出，也不会写入会话日志。pi-ai SDK 不会向其适配器暴露注释活动，因此该路径只能在 SDK 产出值时重新启动定时器。稳定信号在整个调用期间传给 `fetch` 或 SDK，因此超时会关闭底层请求并映射为 `TIMEOUT`，而更早的调用方中止映射为 `ABORTED`。

## 后果

- `runBash` 的结果不再独立锁存 `timedOut` 和 `aborted`；超时与用户中止在进程关闭前竞争时，现在报告单一的首个 abort 原因，而非两者同时为 true。超时分类不改变由提供方管理的终止：本地 POSIX 范围使用 TERM→宽限期→KILL，Windows 普通范围则立即终止。Service Definition 类型 `ShellRunResult` 保留两个布尔值（现在互斥），因此 `dsh-tool-bash` 的结果渲染不受影响。
- `SpawnSpec.timeoutMs` 和 `SpawnOutcome.timedOut`/`aborted` 被移除，而非作为始终为零/始终为 false 的残余保留：由于 `runBash` 不再拥有定时器且执行器负责分类，这些字段无处被读取。一个始终为 0 且无处读取的字段在逐文件覆盖率门禁下属于死代码。
- web_fetch 去除了其定制的 controller/timer/listener/reason-recovery；分类器现在基于 deadline 信号（`timeoutOf` + `aborted`）而非抛出错误的形状来判断，这在请求阶段的 reject-with-reason 和读取阶段的裸 `AbortError` 两种情况下都是健壮的。
- `AbortSignal.any` 和 `using`/`Symbol.dispose` 在此首次进入本仓库（Node ≥ 24 基线，已满足）。
- 模型流现在共享一个可重启的定时器约定，不会把滑动的空闲间隔变成总调用截止时间，也不会计入消费方思考时间。能够观察到带外传输活动的适配器可以对尚未结算的 demand 调用 `pulse()`；被屏蔽的活动对 watchdog 仍不可见。该原语仍然只做通知；适配器测试证明其传输观察到稳定信号并终止。

以下内容不在本次范围内，列出以标明边界：`web_search` 可以在其工具 schema 和快照覆盖规划完成后获得可选的面向模型的 `timeout_ms`；基于 ripgrep 的文件系统发现工具（[打包的 ripgrep 搜索](../../archived/architecture/2026-08-01-packaged-ripgrep-search.md)）通过 `dsh-tool-call-timeout-policy` 和 `exec.signal` 消费同样的提供方自有 deadline 形状；`tools/execute` waterfall（瀑布式事件）中间件可以通过驱动 `exec.signal` 为每次工具调用设置默认 deadline——那将是一个*消费*本库的插件，仍然只做通知，硬终止仍是各能力自己的事。

## 曾考虑的替代方案

**统一的超时*插件* / `ctx.timeout` 服务。** 基于微内核原则否决。一个能停止任何工具工作的服务必须理解每个能力的终止机制（原生 scope 或 Job 终止、fallback 进程组信号、socket 拆除、系统调用边界检查），这正是架构所禁止的「内核知道太多」。Codex 的 `ExecExpiration` 被限定于 exec 族，正是因为它驱动的 kill（`killpg`）是进程族特有的；MCP 和模型流各自保有自己的。不存在一个连贯的中间层能为所有东西拥有终止权，因此共享部分只能是纯计时/分类那一半——一个库，而非服务。

**每个工具各自实现超时，不共享代码（先前的现状，也是 Claude Code 的选择）。** 否决，因为它已经在产生分化和重复的正确性负担：web_fetch 手写了与未来网络/进程类工具各自需要重新推导的完全相同的 controller/reason 逻辑，而融合 + `signal.reason` 恢复正是容易出错的部分。Claude Code 容忍完全重复；本仓库有一个统一的共享 abort 通道（每次 `execute` 上的 `exec.signal`），使得采用一个小型共享原语明显更简洁，因此成本/收益不同。

**用 `withTimeout(promise, ms)` 包装器代替信号工厂。** 否决，因为让 promise 与定时器竞争只是在截止时间到达时 resolve *工具调用*的 promise，而不会停止底层工作——子进程或 fetch socket 会泄漏。分发信号并要求能力监听，才能强制一条真实的终止路径存在。这与「dispose 必须达到完全停稳，而非仅仅请求它」的防御性规则一致。

**保留 bash 独立的超时和取消触发器。** 否决，因为一个 deadline 信号移除了定制定时器并标准化了分类。发生竞争时，报告先到达的那个 abort 作为原因，由提供方管理的终止路径不受哪个原因先胜出的影响。
