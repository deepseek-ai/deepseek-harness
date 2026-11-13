# Agent Note: 为自动化输入提供具有类型约束的 source 实例

Status: implemented

[English](2026-11-11-typed-source-instances.md) | 中文

## 问题

观测事件和决定是否输出，可能需要共享同一份局部状态与定时器。将两者拆成 source provider 和每任务 handler，会模糊状态属于哪个对象。按 source kind 只注册一个对象，也混淆了实现 class 与使用该实现的独立配置的观测实例。

## 决策

[`AutomationSource<TOut>`](../../../../packages/schedule/schedule/source/README.zh.md) 表示一个产生输出的实例。具体 class 拥有观测、类型化输入、计时与条件求值；同一 class 可以有多个独立实例。接收者通过 `sourceB.connect(sourceA.output)` 连接上游输出。Source 与 runtime 使用相同的 `SourceInput` 协议：`ctx.schedule.input(id).connect(source.output)` 为已有任务接受最终 `{ text }` 候选。Source 之间的数据保留各自类型。Source class 不需要独立路由器、任务标识注册表、handler 或接收者注册。

`connection.send(value)` 定向发给一个接收者；`emit(value)` 对输出的连接快照使用同一操作广播。共享连接保留其方向与关闭状态。广播等待全部接收者并聚合失败，不执行回滚，因此一个失败不会阻止无关接收者。连接销毁会拒绝新发送；即使连接已经从端点断开，重复销毁仍会等待已接受调用。复合 Source 先关闭并排空自有输入，再关闭输出，让已接受输入完成派生投递；它不销毁借用的上游实例。组合者显式保留下游输入和存储，直到依赖它们的生产者排空。组合者声明 Schedule 依赖；按排空顺序清理的消费者子作用域继承该依赖。子作用域独立声明该依赖，会让 provider 失活时先关闭该子作用域，而不是等待组合者的有序清理执行到它。

`TimeSource` 拥有时钟生产、合并的可确认请求和分段定时器。它接受已计算的截止时间，通过共同的输出协议发出实际墙钟毫秒值。runtime 的数值输入等待事务内的到期扫描；runtime 策略拥有重复规则、最小投递间隔、批量投递与持久化。时钟生产不替换任务时间策略。

本决策取代[事件触发任务提案](../../proposed/feature/2026-10-29-event-triggered-automation-tasks.zh.md)中的 provider/trigger 实现拆分，不取代其尚未实现的产品功能。该提案继续用于纯事件任务存储、受限事件轮次、观测记录和通知。已有定时任务的存储与求值独立于这些通过代码创建的 source 连接。

## 考虑过的替代方案

**每 kind 一个 provider，绑定任务并配合独立 handler。** 这种方案使独立实例无法直接拥有自身观测，并把计时与条件状态分散到两个扩展接口。复合条件改由另一个具有类型化输入的 source class 表达。

**实例地址注册表和持久化依赖图。** 当前 source 组合不需要序列化或字符串查找。直接引用保留输入类型，也避免在消费者需要之前定义图调度、路由循环、未知载荷校验和重新连接语义。

**包装 Cordis scope 的 source 工厂服务。** Cordis 已经拥有插件 effect。增加另一套创建和 scope 机制会重复管理所有权，却没有 source 专属操作；任务投递使用拥有任务存储的既有 Schedule 服务。

**独立任务路由器与接收者注册。** 两个服务就绪，不会为另一 injection child 中的接收者注册确定先后顺序。组合插件可能先于该 child 的注册进入活动状态。将连接操作放在 Schedule 上，使任务投递与 Schedule 一起就绪，也不要求已有纯定时组合增加路由器。

## 后果

插件作者显式构造与销毁 source 实例，继续负责轮询预算、输入串行化、持久化观测状态以及后台生产者的失败报告。Source 实例、连接和中间观测仅存在于进程内；任务连接不创建纯事件任务或受限执行模式。外部观测实现必须在把数据交给普通任务之前，明确自己的信任和权限策略。

任务仍由 Schedule 持久化。任务输入保留已存储的指令、时间规则与状态，把 source 数据追加到已记录的用户消息中，并确认 Session 持久化和任务回执，而不是模型执行完成。两次提交并不原子，source 广播也不是事务；自动重放可能重复已经提交的投递。Loader 卸载组合插件或必需的 provider 失活时，都适用这些生命周期要求。
