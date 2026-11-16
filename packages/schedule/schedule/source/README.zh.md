---
description: "把类型化 Source 输出连接到接收方 Source 和 Schedule 输入；本参考涵盖定向投递、广播、清理、TimeSource 与共享构造器身份。"
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule/source

[English](README.md) | 中文

## 概述

组合独立的 Source 实例，让每个接收者连接上游输出。可以通过一条连接发送值，也可以广播给全部已连接的接收者。中间值保留各自的类型；最终文本可以伴随已有自动化任务的指令投递。多个 Source 可以连接同一输入，一个输出也可以连接多个输入。连接关闭时等待已接受的工作。实例与中间状态仅存在于进程内。

## 目录

- [使用本入口](#use-this-entry)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-entry"></a>
## 使用本入口

继承 `AutomationSource<TOut>`，拥有输出及通过 `createInput<TIn>(receive)` 创建的输入。复合 Source 暴露输入已绑定的 `connect` 函数：`sourceB.connect(sourceA.output)` 建立从 A 到 B 的投递。具有不同输入类型的 class 可以暴露 `connectLeft` 和 `connectRight`。纯生产者只需要输出及其生产方法。

```ts
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'
import type { AutomationCandidate } from '@deepseek-ai/dsh-schedule'

class StatusSource extends AutomationSource<string> {
  publish(status: string): Promise<void> {
    return this.emit(status)
  }
}

class StatusText extends AutomationSource<AutomationCandidate> {
  readonly connect = this.createInput<string>(async status => {
    await this.emit({ text: status })
  }).connect
}

const first = new StatusSource()
const second = new StatusText()
const connection = second.connect(first.output)
await first.publish('changed')
await connection.send('direct observation')
await connection.dispose()
await second.dispose()
await first.dispose()
```

`SourceInput<T>` 接受返回 `Promise<void>` 的 `SourceReceiver<T>` 回调。成功返回确认本次输入操作，而不是它将来可能产生的全部输出。接收者可以更新状态，等待另一个输入后再发出数据；接收者若等待派生输出，则其确认包含该次投递。Schedule 根入口也直接提供 `SourceOutput<T>` 和 `SourceInput<T>`。本子路径不是 Loader 插件，没有 `apply` 或默认导出；正常挂载 Schedule 包即可。

### 定向投递与广播

`connection.send(value)` 只投递给该连接的接收者。共享连接即共享方向、在途调用和关闭状态：任何持有者都可以发送或关闭它。`emit(value)` 通过输出当前连接的快照广播。两条路径都在延后的接收回调运行前登记已接受工作。接收者不得修改共享值。并发发送和广播可以重叠；协议不提供 FIFO。

定向发送保留接收者的原始拒绝。广播等待每个接收者结束，并以 `SOURCE_DELIVERY_FAILED` 和聚合 cause 报告失败。其他接收者可能已经提交：投递不具备原子性，协议不重试或重放。没有连接的输出直接完成，不执行投递。

### 连接任务输入

组合插件声明 `schedule` 依赖，对包含 `AutomationCandidate.text` 的输出使用 `ctx.schedule.input(taskId).connect(source.output)`。Schedule 在调用方 context 中拥有返回的 `SourceInput<AutomationCandidate>`，并在其 runtime 停止时关闭该输入。每条连接都是提供 `send()` 和 `dispose()` 的普通 `AutomationConnection<AutomationCandidate>`；重复销毁也会等待已接受工作。[Schedule 包](../README.zh.md#source-delivery)拥有任务准入、持久化确认与消息格式。

`input(taskId)` 要求 Schedule 服务已就绪且正在运行，否则抛出 `SOURCE_TASK_RECEIVER_UNAVAILABLE`。如果回调到达服务时 mutation FIFO 已停止接受新工作，该调用以 `SOURCE_CLOSED` 拒绝；此前已进入 FIFO 的工作仍会完成。停止的 runtime 关闭其输入与连接，不重新绑定。通过已关闭连接发送会以 `SOURCE_CONNECTION_CLOSED` 拒绝；仍然打开但已没有连接的输出在广播时不执行投递。替代服务就绪后，再连接新的输入。

### 时间输入

`TimeSource` 输出数值形式的实际 `Date.now()` 采样。其构造器接收一个不得抛错的失败报告回调。`request()` 取消定时器并请求采样；广播尚未结束时的请求合并为下一次采样。`arm(next)` 向有限的 Unix 纪元毫秒截止时间设置一个有界定时器分段；`arm(undefined)` 取消它。长等待的每个分段都发出采样，由接收者根据计算出的截止时间重新设置定时器。销毁停止请求，并等待已接受的输出。

Schedule runtime 使用由 `SourceInput<number>` 实现的 `runtime.connect(time.output)`。其接收者直接在修改 FIFO 内等待到期扫描，而不是请求另一个时间信号。runtime 任务策略计算下一个截止时间，并拥有重复规则求值、批量投递、最小投递间隔及已存发生时点。`TimeSource` 不解析时间规则。其数值输出不能直接连接文本任务输入；共同的连接语义不取消载荷类型约束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 清理所有权

即使连接已经断开，输入端与输出端仍跟踪已接受调用。关闭任一端点会拒绝新连接并关闭其已有连接；关闭连接会拒绝新发送。重复销毁会等待同一次排空。单独销毁的输入在排空成功前仍由其 Source 拥有；之后 Source 释放该输入，不关闭其他输入或输出。没有剩余自有输入时，Source 销毁会立即停止输出接纳新调用。`AutomationSource.dispose()` 先关闭并排空自有输入，此时输出仍可使用，再关闭并排空输出。子类在调用它之前停止外部生产者。借用的上游 Source 仍由其创建者拥有。

接收者不得在已接受调用内部等待自身连接、输入、Source 或当前发起输出者的销毁：这些清理会等待该调用返回。连接与端点的销毁等待调用结束；投递错误由原始发送或广播负责报告。

排空期间可能发出数据的复合 Source 必须先于任务输入完成清理。组合插件必须声明 `schedule`；其显式拥有的消费者子作用域通过 `ctx.inject([])` 继承该绑定。在子作用域的注入中重复声明 `schedule`，会让 provider 失活时独立卸载它，先于复合 Source 排空。任务输入由调用方拥有的 Cordis effect 与其公共 disposer 分开：yield 包装 `input.dispose()` 或 `connection.dispose()` 的函数不会转移该 effect 的所有权。在同一个同步 generator effect 中先 yield 原始子作用域 disposer，后 yield 复合 Source 清理。逆序清理先排空复合 Source，再销毁消费者子作用域。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationCandidate, AutomationSource, ScheduleId } from '@deepseek-ai/dsh-schedule'

export function ownComposite(ctx: Context, id: ScheduleId, composite: AutomationSource<AutomationCandidate>): void {
  const consumer = ctx.inject([], scope => {
    scope.schedule.input(id).connect(composite.output)
  })
  ctx.effect(function* () {
    yield consumer.dispose
    yield () => composite.dispose()
  })
}
```

### 发布与实现归属

根入口拥有 `SourceError`、`SourceInput`、`SourceOutput` 与 `TimeSource` 的运行时构造器。leaf 从 `@deepseek-ai/dsh-schedule` 导入这些构造器，并重新导出输入、输出和时间 class。因此根入口与 leaf 的消费者共享构造器身份。根入口只以类型导出 `AutomationSource`，不在运行时导入 leaf。根入口拥有的协议通过相对路径导入其错误；编译后的 leaf 不得通过相对路径导入根入口所拥有 class 的独立副本。

[`source-protocol.ts`](../src/source-protocol.ts) 拥有输入、输出与定向连接；[`source.ts`](../src/source.ts) 拥有复合 Source 输入先于输出的清理；[`time-source.ts`](../src/time-source.ts) 拥有时钟请求与分段定时器。[`source-types.ts`](../src/source-types.ts) 定义接收者、连接、候选值和错误码类型。Schedule 保留任务查找、激活、准入与持久化职责。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Schedule 子系统](../../../../docs/subsystems/schedule.zh.md#source-instances)——source 与任务投递语义。
- [Schedule 包](../README.zh.md)——任务存储、目标和模型可见的提醒格式。
- [Cordis 入门](../../../../docs/cordis-primer.zh.md)——插件依赖与可逆 effect。

-----

<a id="model-experience"></a>
## 模型体验

### Source 生成的任务输入

#### 模型看到什么

Source 之间的观测与 TimeSource 采样不是模型输入。文本任务输入将候选文本提交给 Schedule；[Schedule 的 source 观测章节](../README.zh.md#source-observations-in-the-target-session)定义最终记录的用户消息与格式。本入口不添加工具或提示词段落。

#### Token 影响

中间观测不增加模型 token。被接受的任务投递把候选文本与 Schedule 的格式文本添加到对应 Session 的对话中；精确 token 由链接的 Schedule 章节拥有。

#### KV Cache 影响

Source 连接不会改变请求前缀。任务投递通过 Schedule 服务追加输入；回放与请求构造由该服务负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- Source 实例、连接和中间状态仅存在于进程内。插件必须明确拥有需要持久化的观测状态，并在重启后重建组合。
- 组合通过代码完成，不提供 Source 编辑器、持久化依赖图、handler 层或通用轮询与重试策略。TimeSource 接受已计算的截止时间，不增加任务类型或配置格式。
- Source 的所有者在发布之前限制观测大小与输出速率。本 API 完整保留候选文本，不做截断，也不设置入口级大小上限。持续以共享间隔发布的 Source 可以无限推迟定时投递；它必须为定时工作留出容量。
- 文本任务输入保留已有任务时间规则。正在执行、处于最小间隔内或正在恢复未完成投递的任务会以 `SOURCE_TASK_BUSY` 拒绝本次候选。直接发送保留该错误；广播聚合该错误。任务不会存储或排队该候选，恢复持有的是上一条收件箱投递。生产者负责重试与限速。
- Source 投递不增加纯事件任务 schema 或持久化连接图。共享连接不转移排他所有权，也不提供按调用者区分的访问控制。
