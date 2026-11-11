---
description: "组合具有类型约束的 source 实例，并把输出投递给自动化任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-source

[English](README.md) | 中文

## 概述

在插件中组合独立的 source 实例，并在实例之间传递有类型约束的观测值。一个 source class 可以有多个实例，可以接收多个其他 source 的输入，也可以把输出交给多个消费者。最终文本准备好作为模型输入时，再把它连接到已存储的自动化任务。投递是异步的，断开连接会等待已接收的工作，而不是丢弃它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

每个 source class 继承 `AutomationSource<T>`。每个实例拥有自己的状态、观测和所需定时器。它的输入方法保留各自的类型；订阅上游实例不需要 kind 注册表、handler 或任务绑定。

```ts
import { AutomationSource } from '@deepseek-ai/dsh-source/source'

class StatusSource extends AutomationSource<string> {
  publish(status: string): Promise<void> {
    return this.emit(status)
  }
}

const first = new StatusSource()
const second = new StatusSource()
const connection = first.subscribe(status => second.publish(status))
await first.publish('changed')
await connection.dispose()
await first.dispose()
await second.dispose()
```

需要投递到任务时，在 `@deepseek-ai/dsh-schedule` 之前挂载 `@deepseek-ai/dsh-source`，并保留 Schedule 正常使用的存储与 Session 依赖。组合插件注入 `automationTasks`，对 `AutomationSource<AutomationCandidate>` 调用 `ctx.automationTasks.connect(source, taskId)`。任务服务接收 `{ text }` 输出；中间 source 可以使用任意具有类型约束的输出。一个 source 可以连接多个任务，多个 source 也可以连接同一个任务。

组合插件通过 `ctx.effect()` 拥有 source 和连接。在释放依赖它们的 source 或任务存储之前，先停止并排空生产者。复合 source 只断开自己持有的上游订阅，不销毁借用的上游实例。接收回调不能在自身内部等待自己连接的销毁，因为销毁需要等待这次调用返回。

输出会等待所有接收者，即使其中一个失败。接收者可以并发运行；除非生产者主动串行化，连续输出也可以重叠。`SOURCE_DELIVERY_FAILED` 错误在聚合 cause 中保留所有接收失败。有些接收者可能已经提交；source 和任务路由器都不会重试整次输出。任务连接捕获当次接收者注册，注册卸载后会拒绝投递，不会自动切换到替代实例。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

source 通过实例拥有的订阅集合和具有类型约束的回调通信。基类在调用接收者之前记录已接收的调用，因此断开连接和销毁 source 都能等待这些调用。基类不拥有轮询频率、重复规则求值器、source 工厂或依赖图解释器。子类先停止外部生产者并排空输入，再销毁输出订阅。

动态挂载的任务路由器把最终 source 输出连接到已注册的任务服务。仅与其他 source 通信的实例不使用这个服务。任务服务继续拥有任务查找、活动状态检查、投递限流、目标 Session 激活和持久化确认。订阅实现见 [source.ts](src/source.ts)，任务连接实现见 [index.ts](src/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Schedule 子系统](../../../docs/subsystems/schedule.zh.md#source-instances)——source 与任务投递语义。
- [Schedule 包](../schedule/README.zh.md)——任务存储、目标和模型可见的提醒格式。
- [Cordis 入门](../../../docs/cordis-primer.zh.md)——插件依赖与可逆 effect。

-----

<a id="model-experience"></a>
## 模型体验

### source 生成的任务输入

#### 模型看到什么

source 之间的观测值不是模型输入。任务连接把候选文本提交给任务服务；[Schedule 的 source 投递格式](../schedule/README.zh.md#source-delivery)定义最终记录的用户消息。本包不添加工具或提示词段落。

#### Token 影响

中间观测不增加模型 token。被接受的任务投递把候选文本与任务服务的格式文本添加到对应 Session 的对话中。

#### KV Cache 影响

source 订阅不会改变请求前缀。任务投递通过接收服务追加输入；回放与请求构造由该服务负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- source 实例、连接和中间状态仅存在于进程内。插件必须明确拥有需要持久化的观测状态，并在重启后重建组合。
- 组合通过代码完成。本包不提供 source 编辑器、持久化依赖图、内置观测实现或通用轮询与重试策略。
- Schedule 的 source 接收者只接受已存在的活动任务，并保留其时间规则。这种连接不替换已存储的时间模型，也不创建纯事件任务。
