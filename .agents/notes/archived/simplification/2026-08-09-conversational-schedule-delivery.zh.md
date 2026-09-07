# Agent Note: 对话式 Schedule 交付

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-conversational-schedule-delivery.md) | 中文

## 问题

Schedule 已经通过将普通的 agent（智能体）后续轮次排入队列来交付到期提醒。第二条持久 Web 回执通过 Schedule 投影、持久化成功事件、Host 历史记录与 live 伴随数据、客户端同序号升级、通用事件视图 slot 和专用渲染器表示同一次提醒触发。这条路径把一项功能的确认 UI 分散到会话、持久化、Host、客户端运行时、对话 UI 和一个额外包中。

该回执还让「交付」有了第二种含义。即使模型轮次失败，它仍然可见，而对话本身没有成功的提醒答复。用户需要定时对话继续进行；他们不需要一枚单独的持久标记来证明内部 dispatch 已经尝试过。

## 决策

到期提醒会等待 agent 的 idle maintenance phase，再调用 `followup()`。该操作会在稍后开启一个普通轮次，并通过普通对话 transcript（文本记录）显示；Schedule 绝不会调用 `steer()`，也绝不会中断当前轮次。

`schedule/change` 仍是唯一持久 Schedule 状态。其 dispatch 操作记录后续轮次已同步入队，这会在 dispatch 持久化后阻止普通的重启回放。dispatch 不表示模型成功、用户确认或外部通知。入队与持久 dispatch 之间的狭窄崩溃窗口仍保留至少一次语义。

Schedule 不公开交付回执 projection、Host 伴随数据、浏览器事件节点、按事件键控的 slot 或回执 renderer。会话持久化保留共享的 `flush()` 约定，且不存在由 Schedule 驱动的成功事件。另一条 Session projection 可以发布完整的当前活动记录集合，`dsh-client-ui-schedule` 可以只读渲染该集合；两者都不包含 dispatch 成功、acknowledgement 或 transcript 历史。显式启用的 Web overlay 会加载 Host Schedule 服务，并启用 Web bundle 中默认 disabled 的目录 row。

## 已考虑的替代方案

**保留提交感知回执。** 即使模型失败，它也可以证明 dispatch 已到达持久化，但这是实现结果，而不是用户的提醒。其跨组件协议与后到的同序号合并逻辑，与这点价值不成比例。

**在对话中渲染原始 `schedule/change` 事件。** 这样可以避免领域卡片，但仍会把内部状态转换暴露为面向用户的消息，而且仅为 Schedule 就需要通用的内部事件呈现机制。

**把 dispatch 当作提醒已成功交付。** dispatch 发生在模型请求之前，无法证明 assistant 答复存在或已被读取。将其称为交付会夸大持久事实。

**提醒到期时中途引导当前轮次。** 中途引导会改变进行中的请求路径，并让定时触发中断无关工作。等待完全 idle 后使用 `followup()`，可让每条提醒分别进入一个普通的后续轮次。

## 验证

包生命周期测试固定 idle 等待、maintenance 所有权、后续轮次先于 dispatch 的顺序、同步入队失败、与模型无关的 dispatch 和重启回放。组装后的 Web 场景为产生的 assistant 行生成快照，并断言已持久化的 Schedule dispatch 没有特殊 history view、Toast 或回执。projection 与目录测试另行证明只有活动记录出现，并在终结 transition 后消失。源码与依赖审计会拒绝残留的已移除回执符号、事件、sidecar、按事件键控的 slot 与 renderer 路径。

## 后果

- Schedule 交付仅涉及其自身包与常规组合；Session、持久化、Host 载体和对话渲染不携带 Schedule 专属回执行为。可选的活动状态 projection 与 header 目录是另一项只读关注点。
- 用户只能通过对话中的普通模型响应看到提醒。失败的模型轮次仍是失败轮次，不会出现与之矛盾的成功回执。
- 需要外部交付或交付确认的消费方必须采用另一条产品边界，并由其拥有自己的通知和确认语义。
