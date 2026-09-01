---
description: "面向用户与维护者的 subagent 委派 seam，用于选择提供方后端、组装委派工具或排查子 agent 运行问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

## 概述

`dsh-subagent` 是子 agent 委派背后的服务：agent（智能体）把任务交给具名子 agent，收集完成的结果，并且——对可继续子 agent 而言——跨轮次持续发送后续工作。多个提供方在同一约定下共存，因此单个组合可以并排提供进程内子 agent、进程外 ACP 或 SDK 子 agent，以及真实 Codex 或 Claude Code 子 agent。子 agent 有两种形态：一次性运行以单个结果结算，可继续子 agent 的持久会话则接受后续消息并可被中断。同一服务还回答发现类问题——存在哪些子级、它们的模式、活动状态与血缘——而不加载或恢复它们。把它与至少一个提供方后端和一个委派工具一起挂载；后端与面向模型的工具位于兄弟包中。

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

本包是每个委派组合都共享的约定。你通过把服务与一个或多个提供方后端以及面向模型的委派工具一起挂载来启用它；此后 agent 即可委派工作，服务会把每个请求路由到具名提供方。

### 启用委派

把服务与一个提供方和委派工具一起挂载。提供方以你配置的名称注册（进程内 spawn 后端默认为 `spawn`）；工具行指名该提供方，让模型看到一个静态工具。一个最小的一次性配置：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

调用该工具的 agent 会把子 agent 的最终答案作为工具结果收到。只挂载服务本身不会改变任何行为：在组合出提供方和工具之前，什么都不能委派。

### 一次性与可继续子级

一次性子 agent 只运行一次，并以单个结果结算，可附带可选的结构化输出与失败时的安全诊断。启动请求可以通过 `agentOptions` 覆盖子 Agent 的提供方、模型、推理等级与输出 token 上限；每个请求的选项都要求提供方声明对应能力。可继续子 agent 保留持久会话并按顺序接受后续消息：调用方收到稳定的子 agent id、发送相邻 Agent 消息，并可中断当前轮次而不销毁子 agent。工具行的 `backgroundMode` 选择形态（默认 `one-shot`，或在支持的提供方上使用 `continuable`）。

### 消息、中断与发现

每个确切在线 Agent 都可以对直接可继续 child 使用 `sendMessage()`；驻留的可继续 child 还可以对自己的直接 parent 使用它。正在工作的目标通过 Steer 在最近 step 接收消息；空闲目标启动轮次，且只有直接 child 可以冷恢复。parent 也可以随时中断正在运行的后代或列举自己的子级。浏览器发出的继续执行 prompt 可以携带图片部分：Host 先通过附件存储完成整批图片的准入与持久化，子级 inbox 才接受这条消息；当子级声明的模型不接受图片输入时拒绝投递。发现覆盖两种形态：服务列举直接子级与完整后代树——模式、活动状态与血缘——直接读取在线会话状态与可选持久化，不加载任何子 agent。

### 失败与恢复

需要所选提供方不具备的能力的请求会在启动时响亮失败，而不会被静默忽略。失败的子 agent 运行会返回停止原因，提供方后端还会附加安全诊断；被取消的请求以 `aborted` 结算。子 agent 相互隔离：崩溃或行为异常的子 agent 无法破坏父级会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务的构建方式以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **一个服务，多个提供方。** 服务是具名提供方注册表；每个后端以唯一名称注册，请求按名称选择一个。
- **两种子级形态。** 一次性运行在发布时转移所有权；可继续子级保留持久 Session，且同一时刻至多一个进程内 Activation。
- **兑现即发布。** 提供方的 `start()` 只有在真实子 agent 存在后才兑现，因此调用方要么拥有一段在线运行，要么一无所有。
- **同进程值可信。** 请求、描述符与结果按不可变约定借用；序列化与不可信输入校验属于进程与协议边界。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：提供方注册表、启动与继续 API、生命周期事件 |
| [`src/continuation.ts`](src/continuation.ts) | 可继续子级：身份预留、Activation 驻留、相邻消息、中断、结算 |
| [`src/internal.ts`](src/internal.ts) | 供浏览器与 Team 消息协议使用的 host-only Queue 适配器 |
| [`src/types.ts`](src/types.ts) | 公开的请求、结果与提供方约定 |
| [`src/descriptor.ts`](src/descriptor.ts) | 版本化的 `subagent/descriptor` 会话事件词汇 |
| [`src/child-agent.ts`](src/child-agent.ts) | 子级组装、委派策略、深度辅助函数 |
| [`src/list-children.ts`](src/list-children.ts) | 基于在线会话存储与可选持久化的发现 |
| [`src/control.ts`](src/control.ts) | 浏览器控制面组装：目录活性采样、浏览器时区校验、失败分码 |
| [`src/control-types.ts`](src/control-types.ts) | client-safe 的目录行、控制面请求、回执与失败 |

### 一次性流程

请求先对照提供方声明的能力进行校验，随后对持久化描述符做快照，再由提供方构建子 agent。两个进程内提供方都声明 `agentOptions`：创建子级时把请求字段叠加到父级最新已记录请求的提供方、模型与推理等级之上；父级还没有请求时回退到创建选项，并保留配置的 token 上限。更改路由而不显式指定推理等级时，会清除继承的路由自有等级，使所选模型解析自己的默认值。DSH SDK 也声明该能力并公开不可变的 `agentRouteDefaults`，使其实例持有的提供方／模型默认值在确切路由预检前成为基线；`start()` 仍负责直接调用方与输出上限。ACP、Codex 与 Claude Code 会拒绝 agent 路由覆盖，而不是静默忽略。成功时运行被发布、所有权转移给调用方；失败时提供方回滚每个尚未发布的资源。结果携带子 agent 的最终输出、可选的结构化值、停止原因与可选的安全诊断。

### 可继续流程

管理器预留 child 身份、解析持久化描述符、创建（或冷恢复）child、把它安装进 Activation 并提交提示词。模型编写的消息通过固定 Steer 调度跨一条 parent/child 边；host 协议保留内部 Queue 适配器以创建独立轮次。直接 child 不存在 Activation 时会从持久化会话冷恢复。当驻留 Activation 结算时，管理器会在 parent 自身的轮次流中告知该 child 的直接 parent。

### 所有权与不变式

- **发布即边界**——发布前提供方拥有设置并须在失败时回滚；发布后调用方拥有运行并须 dispose（资源释放）它。
- **注册受 effect 作用域约束**——移除提供方会阻止新启动，但绝不撤销已接受的运行。
- **Agent 消息权限基于确切相邻关系**——`sendMessage()` 要求确切在线 sender；每个 sender 都可以指定直接可继续 child，只有具备驻留可继续 Activation 的 sender 可以指定自己的直接 parent。
- **描述符仅进日志**——它是会话事件，不进入模型历史，并跨压缩（compaction）保留；可继续描述符会显式记录解析后的子级提供方、模型与推理等级，用于冷恢复。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享 seam 逐步进入后端、面向模型的工具与设计决策。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [Subagent 能力 seam](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)——委派能力家族的设计记录。
- [可续跑后台 subagent](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.zh.md)——接受后续轮次的持久子级。
- [进程内 spawn 后端](../subagent-spawn-in-process/README.zh.md)——最容易组合的提供方。
- [进程外 ACP 后端](../subagent-acp/README.zh.md)——经 Agent Client Protocol 拥有自有运行时的子级。
- [合并后的 subagent 控制服务](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md)——后续消息、中断与列举面。

-----

<a id="model-experience"></a>
## 模型体验

### 结算通知

#### 模型看到什么

一条用户角色的父级消息，开头是结果本身——`Background subagent <child-id> finished and will do no further work unless you send it more.`，或子级被停止、耗尽额度、拒绝任务或失败时的对应句子——随后是 `Its closing message:` 与子级的最终 assistant 内容；若子级没有产出内容，则是 `It left no closing message.`。这条由 runtime 生成的通知与模型编写的父子消息相互独立；后者使用 `sendMessage()` 与 `AgentMessageSource`。委派 schema 与模型控制工具归 Consumer 包所有。

#### Token 影响

父级请求中，每个已结算的 Activation 一条通知，长度取决于子级的最终消息。如果子级先发送自己的消息再结算，父级请求会同时承担两者。

#### KV Cache 影响

在父级中仅追加：通知位于其可复用请求前缀之后。到达空闲父级会启动一次独立的模型请求，到达繁忙父级则不会。

### 子级委派范围声明

#### 模型看到什么

每个进程内子 agent 的运行时上下文快照都携带下方的 `subagent:delegation` 声明，位于沙箱策略与审批策略语句之后。

##### 委派范围声明

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token 影响

每个子 agent 的运行时上下文快照中一条固定声明；父级请求中没有任何新增。

#### KV Cache 影响

子级内部前缀稳定：该声明在子 agent 生命周期内绝不变化，因此只写入第一份运行时上下文快照一次。父级侧不会直接使缓存失效；具名工具消费方共同负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用委派对比或任务积压。

- **ACP 子级仍为一次性，且无法通过追踪枚举**——ACP 运行在父级会话语料中没有本地子会话，远程提供方需要 Activation 所有权约定才能支持可继续子级。
- **仅允许相邻模型消息**——`sendMessage()` 要求确切在线 sender；每个 sender 都可以指定直接可继续 child，只有具备驻留可继续 Activation 的 sender 可以指定自己的直接 parent。浏览器提示使用独立的 Queue 控制路径。
- **child 到 parent 的投递要求直接 parent 保持在线**——服务没有持久 parent mailbox；parent 缺失时会拒绝消息，而非接受无法唤醒的工作。
- **取消收敛期间存在唤醒缺口**——中断信号发出后、driver 进入 idle 前被接受的后续消息会保持排队，直到另一条唤醒发送到达。
- **驻留仅限进程内**——Activation inbox 与所有权图不会在两个 harness 进程之间协调；对单个持久化存储的并发访问需要持久化邮箱与跨进程租约协议。
- **不回放已接受但未记录的消息**——崩溃可能丢失从未写入子会话日志、已被接受的提示词；丢失的消息不会自动回放。
- **没有持久化 parent mailbox**——child 到 parent 的消息要求驻留的可继续 child 与在线直接 parent，提供的是接受标识，不保证恰好一次投递。
- **生命周期事件只供观察**——影响运行的 `subagent/end` 延续或决策接口仍需等待具体消费方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **跨进程继续执行**——持久化邮箱与租约协议可让两个 harness 进程共享一个持久化存储。
- **可继续 ACP 子级**——需要持久化远程会话 id 与逐子级的继续执行能力声明。
- **host-user 投递**——未来的 host 适配器需要具体的经认证交互，该 seam 才能获得用户投递能力。

</details>
