---
description: "组合具有类型约束的 source 实例，并把其输出连接到已有 Schedule 任务；本参考涵盖 source class、订阅与 disposer 语义、错误身份与模型可见效果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule/source

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-schedule/source` 是 Schedule 包的类型化 source 入口。在插件中组合独立的 source 实例，并在实例之间传递具有类型约束的观测值。source 之间的数据使用各自的类型，不受任务文本格式约束。一个 source class 可以有多个实例，可以接收多个其他 source 的输入，也可以把输出交给多个消费者。最终文本准备好作为模型输入时，再把它连接到已存储的自动化任务。投递是异步的，断开连接会等待已接收的工作，而不是丢弃它。

## 目录

- [使用本入口](#use-this-entry)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-entry"></a>
## 使用本入口

每个 source class 继承 `AutomationSource<T>`。每个实例拥有自己的状态、观测和所需定时器。它的输入方法保留各自的类型；订阅上游实例不需要 kind 注册表、handler 或任务绑定。

```ts
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'

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

需要投递到任务时，组合插件注入 `schedule`，针对 `AutomationSource<AutomationCandidate>` 和已有 `ScheduleId` 调用 `ctx.schedule.connectSource(source, taskId)`。本入口不是 Loader 插件，没有 `apply` 或默认导出；正常挂载 Schedule 包，并从该子路径导入 class。Schedule 就绪即表示可以建立连接，不需要另外注册接收者。一个 source 可以连接多个任务，多个 source 也可以连接同一个任务。

组合插件通过 `ctx.effect()` 拥有 source；Schedule 自动在调用方 context 中拥有任务连接。`connectSource` 同步返回原始 Cordis disposer 函数，而不是 `SourceConnection` 对象。直接 `source.subscribe` 返回 `SourceConnection`，其 `dispose()` 每次调用都会等待同一批已接受工作；任务连接的首次调用返回排空已接受工作的 Promise；等待该结果或所属插件的销毁，后续调用不执行操作，也不会加入正在进行的排空。generator effect 直接 yield 该 `disconnect` 函数，不要包装它，以安排它与自有 source 的清理顺序。

在释放依赖它们的 source 或任务存储之前，先停止并排空生产者。复合 source 只断开自己持有的上游订阅，不销毁借用的上游实例。接收回调不能在自身内部等待自己连接的销毁，因为销毁需要等待这次调用返回。

输出会等待所有接收者，即使其中一个失败。接收者可以并发运行；除非生产者主动串行化，连续输出也可以重叠。`SOURCE_DELIVERY_FAILED` 错误在聚合 cause 中保留所有接收失败。有些接收者可能已经提交；source 和 Schedule 都不会重试整次输出。任务连接捕获一个 Schedule runtime，其卸载后会拒绝投递，不会自动切换到替代实例。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

source 通过实例拥有的订阅集合和具有类型约束的回调通信。`SourceReceiver<T>` 是异步回调；`SourceConnection.dispose()` 停止新调用，并在每次调用时等待同一批已接受工作；`AutomationCandidate.text` 承载额外输入，不做截断。基类在调用接收者之前记录已接收的调用，因此断开连接和销毁 source 都能等待这些调用。基类不拥有轮询频率、重复规则求值器、source 工厂或依赖图解释器。子类先停止外部生产者并排空输入，再销毁输出订阅。

`SourceError` 声明在 [`src/source-error.ts`](../src/source-error.ts)。Schedule 根 bundle 包含它的唯一构造器：包入口在运行时导出 `SourceError`，仅以类型导出 `AutomationSource`；[`./source`](../src/source.ts) leaf 通过根包 specifier 导入 `SourceError`。根入口不在运行时导入 leaf，因此该导入不产生运行时循环。若 leaf 使用相对导入，会加载 tsc 生成的 `source-error.js` 副本，产生第二个构造器，并破坏 leaf 与根 bundle 之间的 `instanceof` 与错误身份。

source 直接与其他 source 通信。Schedule 把最终 source 输出连接到已有任务，并拥有任务查找、活动状态检查、投递准入、目标 Session 激活和持久化确认。订阅见 [`src/source.ts`](../src/source.ts)，接收者、连接、候选值和错误码类型见 [`src/source-types.ts`](../src/source-types.ts)；[Schedule 包](../README.zh.md#source-delivery)拥有任务连接与投递格式。

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

### source 生成的任务输入

#### 模型看到什么

source 之间的观测值不是模型输入。任务连接把候选文本提交给 Schedule 任务服务；[Schedule 的 source 观测章节](../README.zh.md#source-observations-in-the-target-session)定义最终记录的用户消息与格式。本入口不添加工具或提示词段落。

#### Token 影响

中间观测不增加模型 token。被接受的任务投递把候选文本与 Schedule 的格式文本添加到对应 Session 的对话中；精确 token 由链接的 Schedule 章节拥有。

#### KV Cache 影响

source 订阅不会改变请求前缀。任务投递通过 Schedule 服务追加输入；回放与请求构造由该服务负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- source 实例、连接和中间状态仅存在于进程内。插件必须明确拥有需要持久化的观测状态，并在重启后重建组合。
- 组合通过代码完成。本入口不提供 source 编辑器、持久化依赖图、内置观测实现或通用轮询与重试策略。
- source 的所有者在发布之前限制观测大小与输出速率。本 API 完整保留候选文本，不做截断，也不设置入口级大小上限。
- Schedule 的 source 连接只接受已存在的活动任务，并保留其时间规则。这种连接不替换已存储的时间模型，也不创建纯事件任务。
