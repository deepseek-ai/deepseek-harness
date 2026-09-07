# Agent Note: 显式轮次取消能力

Status: implemented

[English](2026-07-16-explicit-turn-cancellation.md) | 中文

## 问题

取消是一种生命周期短于 Agent（智能体）驱动器的控制能力。自由文本字符串无法完整区分所有调用方，步骤级控制器也无法中断提示词提交、提示词组装、继续决策或轮次终止策略。持久化 `Error`、`AbortSignal.reason` 或后端私有对象还会向持久化回放暴露不稳定的运行时细节。

[发起 Agent 作用域决策](2026-07-15-agent-initiator-scope.zh.md)有意让 AsyncLocalStorage 只携带同一个 Agent。若把轮次、步骤或 signal 状态加入这个与驱动器同生命周期的边界，陈旧的异步后代就会看似仍对后续轮次拥有权限。因此，取消需要一个轮次归属方并显式传播，且不创建另一套环境上下文或公开的轮次包装层。

## 决策

Agent 拥有仅用于运行时的 `AgentCancelCause` 联合类型 `{ kind: 'user' } | { kind: 'parent' }`；`agent.cancel()` 默认使用 `user`。TypeScript 在这个类型化的同进程边界中强制执行该词汇，不提供运行时校验器、后备行为，也不为无类型调用方提供特殊兼容性约定。活跃的 `TurnCancellation` 会把类型化判别字段复制为一个全新且已冻结的 signal 原因；空闲状态下没有可修改的持有者，也不会让后续工作预先进入取消状态。

正在运行的轮次被中断后，以粗粒度的持久化结果 `{ kind: 'aborted' }` 结束。终态事件记录轮次发生了什么，运行时 signal 标识谁请求了取消；回放不会重复保存 `user` 或 `parent`。会话 seed/load 会拒绝携带取消原因或任何其他额外字段的旧式中止记录，因此回放无法重新引入由调用方持有的取消细节。仅限进程内的 `agent/cancel-requested` 通知不会持久化；未来若有审计需求，应使用独立的持久化控制请求事件，让请求与最终结果保持为两项事实。持久化事件不包含调用栈、signal、错误对象、自由文本取消原因或后端私有细节。

AgentLoop 为每个待启动轮次私有地持有一个 `TurnCancellation`。它在通知 `agent/status = running` 前安装该持有者，使其中唯一的 `AbortController` 持续覆盖 inbox 领取、`agent/pre-step`、提示词组装、每个步骤、模型与工具执行以及 `agent/turn-stopping`；随后在发布 `turn/end` 前立即清除所安装的那个持有者。因此，即使驱动器状态可能在持久化刷新结算前保持 `running`，终态事件观察者及其后的持久化刷新也无法取消已完成的轮次工作。所有参与的方法、事件和请求值都会收到同一个显式 signal；下一个轮次会收到全新的 signal。

对于轮次被认领前已取消的排队工作，驱动器只保留一个不携带取消原因的运行前标记。实际生效的 `cancel()` 会先发出仅供观察的 `agent/cancel-requested` 通知并携带最终确定的类型化取消原因，然后才清除排队工作和 steering（中途引导）工作或中止持有者；通知失败不能阻止此次停止，空闲状态下调用则不发出任何通知。通知观察者同步加入队列的工作也会被这次清除，而稍后由 signal 中止观察者加入队列的工作会被锁存，并在被中止的活动收敛到空闲时执行——`disposed` 取消则将其停放（[取消收敛窗口唤醒锁存](../bug-fix/2026-08-07-cancel-convergence-wake-latch.zh.md)）。若 `running` 监听器同步取消旧工作并发送替代提示词，驱动器会丢弃已中止的持有者，并为替代提示词创建全新的持有者。同一活跃持有者上的重复取消遵循首次请求优先，后续调用仍可清除新入队的待处理工作。

显式事件签名传递单个 payload 对象：agent 作用域事件在 payload 中携带 `agent` 和 `signal`，`next` 位于最后；其余 API 保持 `signal` 紧邻 waterfall（瀑布式事件）的最终 `next` 之前。`PreStepContext` 与 `RequestFailureContext` 已退役，其字段并入 `agent/pre-step` 与 `agent/request-error` 的 payload（[payload-object 事件](../../archived/architecture/2026-08-06-agent-event-payload-objects.md)）。进入 pre-step 时、请求配置、请求错误恢复、模型生成、工具执行、审批、轮次停止以及 subagent 或工作流请求都会收到当前 signal。钩子桥接器也必须提供 `RunHookOptions.signal`，使轮次取消能够到达 Bash 执行器由提供方管理的终止与等待边界；[原生 containment 决策](2026-08-28-subprocess-native-containment.zh.md)负责受支持本地路径上的 scope、Job 与 fallback 机制。`SystemPrompt.assemble()` 在 `AssembleContext` 中携带 `signal?: AbortSignal`，因为该对象是显式请求值，也可表示轮次之外不携带 signal 的组装。监听器可以配合该 signal 取消，但不得保留它来控制其他轮次。

`ctx.agents` 仍只携带发起 Agent。环境中的 Agent 并不代表存活、当前轮次或取消权限。cause 读取器是 loop 私有的，它直接陈述机器私有的 slot 不变量（只有 `cancel()` 会中止轮次控制器，且总是携带规范的冻结 cause），而不是对 reason 做结构化再校验；不存在从任意 signal 读取 cause 的公开辅助函数。并发 Agent 会同时隔离各自的发起方身份和轮次 signal；子驱动会遮蔽父发起方，而父请求 signal 仍通过 subagent seam 传递。

Agent dispose（资源释放）会在活跃持有者上请求仅用于运行时的 `{ kind: 'disposed' }` 中断。若取消已经先占用控制器的中断原因，该原因便无法改写，因此终态分类会先检查生命周期状态：资源释放结果优先，之后受支持的 `user` 或 `parent` 取消原因形成粗粒度的中止结果，其他异常保留现有错误路径。ACP（Agent Client Protocol）取消映射为 `user`；进程内 spawn 和 fork 的传播映射为 `parent`。远程 ACP subagent 保持现有协议。

取消仍然是协作式的。AgentLoop 会在异步等待边界前后检查中断，但不会用 `Promise.race` 放弃进程内监听器、适配器或工具 Promise。忽略 signal 的工作必须真正结算，`whenIdle()`、句柄 dispose 和作用域清理才会报告完全停稳。

## 验证

约定测试验证类型化调用方联合类型、冻结且与调用方分离、默认行为与首次请求优先行为、粗粒度的会话 JSON 往返与旧式记录拒绝、ACP `user`、进程内 subagent `parent` 以及 dispose 优先级。AgentLoop 测试让协作式监听器在 pre-step、系统提示词组装、请求、模型流、请求错误恢复、工具执行和轮次停止处等待 signal；并断言同一轮次使用一个 signal，不同轮次使用全新的 signal，终态发布期间和持久化刷新受阻期间不存在取消权限。真实钩子桥接器测试会在报告空闲状态前取消并回收受阻的提示词钩子。

发起方作用域测试断言所有钩子仍观察到同一个 Agent 且没有环境中的轮次 signal，并发 Agent 保持独立的身份与 signal，嵌套子驱动只遮蔽身份。竞态测试覆盖空闲状态取消、运行前取消、从 `running` 监听器提交替代提示词、重复取消以及取消与 dispose 竞争下的完全停稳。

## 考虑过的替代方案

**把 signal 存入 ALS。** ALS 会在整个驱动器生命周期内跟随异步后代，而取消权限在一个轮次结束时就已终止。泄漏的回调可能观察到陈旧 signal，或者迫使实现使用可变的环境状态，因此发起方作用域继续只携带 Agent，控制能力继续显式传递。

**持久化自由文本原因。** 字符串允许拼写漂移、阻碍穷尽分支判断，还会鼓励消费方解析展示文本。运行时使用封闭的可辨识联合类型，终态记录只需要稳定的中止结果。

**在 `turn/end` 中持久化类型化调用方取消原因。** 当前没有任何生产环境中的回放、UI、ACP、遥测或工作流消费方区分 `user` 与 `parent`。把请求来源复制到终态结果会混淆两项事实，还会在没有消费方的情况下引入会话特有校验；未来的审计记录可以包含独立的取消请求事件。

**现在就定义推测性的 `superseded`、`timeout` 和 `shutdown` 变体。** 当前没有 Agent 取消生产方实现这些语义。`shutdown` 已经属于生命周期 dispose；超时或替代只有在拥有明确归属策略和唯一终态含义时才应进入联合类型。

**公开轮次或步骤上下文包装类型。** 现有 seam 已经标识 Agent、轮次和步骤。包装类型会加宽所有 API、重复归属，并诱导调用方把捕获的对象当成持久权限。

**在宽限期后放弃不协作的工作。** 同进程工作仍在运行时就报告空闲状态，会破坏资源清理与资源归属保证。硬终止需要 worker 或进程隔离边界，不属于该控制边界。

## 后果

取消拥有一个运行时归属方、每个活跃轮次一个 signal，以及一套类型化的运行时调用方词汇。会话保留其消费方实际使用的粗粒度 `aborted` 结果，拒绝携带原因的旧式形式，并与运行时对象保持隔离。协作式取消覆盖每个异步轮次扩展点，包括第一个步骤之前和最后一个步骤之后的工作，而终态发布和持久化仍在其权限范围之外。

显式 signal 会给多个公开事件增加参数，并要求插件有意识地转发取消。这是有意设计：权限在调用边界可见，生命周期与轮次匹配，陈旧的环境异步后代无法获得控制能力。不协作的进程内工作可能延迟取消，但所报告的完全停稳仍然真实。
