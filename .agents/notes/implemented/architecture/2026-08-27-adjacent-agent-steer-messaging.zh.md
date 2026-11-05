# Agent Note: 相邻 Agent 共享一个 Steer send_message 操作

Status: implemented

[English](2026-08-27-adjacent-agent-steer-messaging.md) | 中文

邻接消息、发现范围和父子生命周期限制已由[整树通信](2026-10-16-tree-wide-agent-communication.zh.md)替代；其余决策仍然有效。 下文的工具身份标记和初始任务通信指导由[工具拥有通信指导](2026-10-22-subagent-tool-owned-communication.zh.md)取代。

## 问题

可继续 Agent 最初使用方向专属的模型控制。parent 调用 `send_message({ subagent_id, message })`，委托给 FIFO `followup` 服务操作。child 则获得 child 作用域的 `report({ output })` 工具、`tool:report` 系统提示词 section，以及由部署选择的静默或唤醒投递。两个工具用不同 schema、服务路径、来源与调度描述同一个相邻 Agent 操作。

可继续 child 拥有自己的 Session，因此 parent 不会自动收到 child 的 transcript（文本记录）、工具输出或推理。显式消息让 child 在结束前发送可操作的发现。直接创建者仍在线时，runtime 另行通过结算通知投递终态输出。

child 专属工具与系统提示词 section 还位于每个继承 fork 轮次之前。它们让可继续 fork child 的请求头在 fork 旨在复用的历史之前就与 parent 不同，迫使提供方重新预填充整份复制 transcript。

## 决策

`SubagentRuntime.sendMessage(sender, targetId, content, { signal })` 是唯一公开的模型编写消息操作。继续执行管理器只接受确切在线 sender 与同一根树中的目标；[整树通信](2026-10-16-tree-wide-agent-communication.zh.md)负责授权与发现规则。

自身目标、过期 Agent 对象、未知目标和外部执行不是替代路由。操作不接受调用方提供的 source、投递模式、离线根邮箱或提供方分发。

每条被接受的消息都使用 `Agent.steer()`。运行中目标在最近 step 边界接收消息；空闲目标启动轮次。不在线目标先在根下冷恢复，再接受同一 Steer 投递；其创建祖先可以保持离线。管理器保留唤醒发送记账，因此受继续执行管理的目标不会在同步 inbox 插入与 driver 准入之间结算。

所有方向使用同一种持久 source。服务从确切在线发送方推导 `senderSessionId`，并以 `Agent <sender-id> sent a message:` 包装内容。

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'

interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}
```

### 一个模型工具与一条返回指令

全局注册的模型工具与方向无关，并使用一个固定 schema：

```ts
interface SendMessageInput {
  readonly agent: string
  readonly message: string
}
```

parent 与 child 以相同注册表顺序继承相同定义。标准定义携带进程稳定的内部身份，同名的作用域工具不满足该身份。独立选择的 preset 可以省略该工具，历史 descriptor 过滤器可在恢复时移除该工具，作用域替代工具也可以提供不同语义；这些情况都不会收到标准调用指令。当标准工具仍可见时，继续执行管理器会把经过 JSON 编码的直接 parent id、最终回答的自动投递条件，以及提前发送可操作发现的指导追加到 child 初始用户任务。对 fork child 而言，该任务位于继承的已完成轮次前缀之后；没有 child 专属系统提示词 section 或工具 schema 位于此前缀之前。

该指令是指导，不是结算强制。发送不会结束 child 轮次，机制仍允许零次或多次调用，runtime 绝不会因 child 保持沉默而拒绝它。采用独立来源的 `subagent-settled` 通知仅在直接创建者仍在线且投递方式为 `parent` 时，记录 Activation 的结果与终态输出。

浏览器中的人类提示不是模型编写的 Agent 消息。远程提示路径保留私有 Queue 投递，使每条人类提示保持为独立轮次。中断行为与结算投递保持独立。

### 完整移除与重新引入条件

独立的 `@deepseek-ai/dsh-tool-subagent-report` 包、`report` schema、`tool:report` 提示词 section、`reportDelivery` 配置、report 专属消息来源、目录项、组合行和受支持行为快照均已不存在。统一工具放弃了无需接收方的 child 快捷方式，也放弃了让结构性返回工具绕过显式 child allow-list 的旧能力。只有具体用例需要树成员的 `agent` 引用与固定 Steer 无法表达的语义时，这些能力才会重新出现；重新引入需要独立的模型操作与前缀成本证据，而非 `sendMessage()` 之上的别名。

## 考虑过的替代方案

**保留 `followup` 并添加 child 到 parent 路由。** 该名称承诺后续轮次并继承 `Agent.followup()` 语义。它会掩盖选定的最近 step 行为，并为方向无关能力保留以 parent 为中心的名称。

**保留 `sendMessage()` 之上无需接收方的 `report` 包装层。** 这会保留便利的 child 快捷方式，并让作用域局部注册绕过全局工具过滤。它落选是因为独立 schema 与提示词重复一个操作、使 parent 与 child 请求头不同，并允许等价方向再次漂移。

**让 `report` 全局可见。** 根 Agent、一次性 child、远程 child 与无 Agent 调用方无法推导 report 接收方。全局宣传它会让 schema 可见性与权限不一致，而 `send_message` 已显式给出接收方。

**将最终回答当作模型编写的发送。** 即使 child 无法配合，结算通知仍须保留终态输出与异常结束信息。它将 runtime 来源与 child 显式选择发送的发现区分开。

**只依赖工具描述。** 工具描述会在模型考虑该工具后提供帮助；初始任务指导还说明哪些早期发现应发送给 parent，以及最终回答须包含什么，又不会改变继承的系统或工具前缀。

**保留静默投递作为部署策略。** 静默的模型编写消息可能被接受，但空闲目标永远不会读取它。固定 Steer 为两个方向提供一种投递含义，并保持与后续结算通知的接受顺序。

## 后果

- 模型 Consumer 向 parent 与 child 公开一个 `send_message({ agent, message })` 定义，不提供模型选择的 Queue 与 Steer 参数。
- 继续执行管理器仍是整树授权、驻留、冷恢复、唤醒准入与拆卸竞态的唯一所有者。
- 被接受的消息可以延长运行中目标的当前轮次；一起等待的消息共享 next-step FIFO 顺序。
- 调用方取消只在 inbox 接受前掌管工作，不会撤回已接受消息或 dispose（资源释放）目标。
- 初始任务在 fork 前缀之后携带经过 JSON 编码的动态 parent 地址，而请求头系统提示词与工具顺序保持可复用。
- 人类提示、结算通知、QueueDock 与 base bundle 的一次性 fork 策略仍是独立决策。

本决策合并并删除了已完全被取代的 report 工具与 child report 义务记录。它取代[按意图命名的 subagent 继续执行操作](../../archived/simplification/2026-07-27-intent-named-subagent-continuation-operations.md)中的 `followup` 命名选择，并保留[Child Agent 消息先于其结算通知](../../../../packages/subagent/subagent/README.zh.md)中的接受顺序保证。
