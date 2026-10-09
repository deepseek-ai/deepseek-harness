---
description: "面向用户与维护者的 subagent 委派 seam，用于选择提供方后端、组装委派工具或排查子 agent（智能体）运行问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

## 概述

`dsh-subagent` 通过具名提供方委派工作，并收集受管理 activation 的结果。本地 spawn 和 fork 子级保留持久会话以接受后续消息；ACP、DSH SDK、Codex 与 Claude Code 执行一次。所有子级共享准入、取消、所有权与发现机制。使用时组合服务、提供方和委派工具。

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

每次启动可传入可选的 `cwd`；相对路径以父级当前工作目录解析，省略时捕获该当前目录。子级保留父级的起始目录元数据与权限根目录。子级自己的目录值位于继承历史之后，在继续与重启后保留，并独立于父级之后的目录变化。

本包是每个委派组合都共享的约定。你通过把服务与一个或多个提供方后端以及面向模型的委派工具一起挂载来启用它；此后 agent 即可委派工作，服务会把每个请求路由到具名提供方。

### 启用委派

挂载服务、提供方与委派工具。提供方按配置名称注册，每个工具行选择一个提供方。最小配置如下：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

工具立即返回子会话 ID，后台 activation 结算后父级收到完成通知。仅挂载服务本身不会启用委派。

### 委派设置

**插件 → 子智能体**页面的限制部分编辑 Host 的 `subagent` 设置分节。用户值覆盖本插件的组合配置；恢复默认会删除用户覆盖。`maxDepth` 默认为 `1`，在委派工具自身未配置深度时提供默认值。工具显式指定的深度（包括 `provider-managed`）优先。深度 `0` 禁止继承此设置的工具委派；深度 `1` 只允许直接子代理。修改在下一次委派时生效。直接调用服务的调用方仍自行提供可选的请求深度。

### Activation 容量

在 Host 插件上设置 `maxActiveSubagents`，限制每棵 activation 树中在线和正在创建的子级数量。默认值为 `8`，接受正安全整数。顶层父级建立由本地和外部后代共享的池，根父级不占名额。新建和冷恢复在让出执行前预留名额，资源释放完成后才归还。等待后代、有待处理收件箱内容以及正在停止的 activation 仍计入容量；向驻留子级发送消息复用其名额。委派深度是独立策略。

每次新建或冷恢复 Activation 前都会读取当前 `maxActiveSubagents`。调高后已有树可接纳更多子代理；调低后驻留子代理继续运行，使用量降至上限以下前拒绝新接纳。

容量耗尽时，新建或冷恢复以 `ACTIVATION_LIMIT_REACHED` 拒绝（浏览器消息返回 `subagent/delivery-unavailable`）：等待子代理完成，或继续使用现有代理。接纳不会排队，避免等待后代的父代理又等待自己占用的名额。名额仅存在于当前进程，不限制累计 Session 历史或 token 用量。

### 本地与外部子级

`startActivation({ provider, label, request, signal, delivery })` 返回 `{ childId, messageId?, result, dispose }`。提供 `childId` 会选择本地后端，并保证返回 `messageId`。本地子级接受后续消息并支持冷恢复；外部子级只暴露一次执行，拒绝继续输入。`request.agentOptions` 覆盖后端支持的子级模型设置。`delivery: 'parent'` 提供面向模型的完成通知；`delivery: 'caller'` 让工作流等待结果，不发送父级通知，也不附加初始返回指导。本地父级投递需要持久化，调用方投递可以使用临时本地会话；冷恢复需要持久化与 Session 查询服务。

### 消息、中断与发现

每个确切在线 Agent 都可以对直接可继续 child 使用 `sendMessage()`；驻留的可继续 child 还可以对自己的直接 parent 使用它。正在工作的目标通过 Steer 在最近 step 接收 Agent 消息；空闲目标启动轮次，且只有直接 child 可以冷恢复。parent 也可以随时中断正在运行的后代或列举自己的子级。浏览器发出的继续执行 prompt 会独立选择 Queue 或 Steer，并且可以携带图片部分：Host 先通过附件存储完成整批图片的准入与持久化，子级 inbox 才接受这条消息；当子级声明的模型不接受图片输入时拒绝投递。 直接子级发现读取 parent 自有的 `subagentCatalog` projection。`listChildren(parentSessionId, signal?)` 持有一次优先实时来源的 Session 观察，异步返回目录，不读取子级日志。它转发取消信号，并在物化后释放观察。物化以 O(D) 时间保留 D 条事实的父日志事件顺序。外部条目是叶节点，不需要观察子 Session。后代发现按父事件顺序递归读取子级目录，每个可达 Session 观察一次。无法读取目录的分支会被跳过，并返回诊断；两条路径都不加载或恢复子级 Agent。

### 失败与恢复

缺少 `agents` 服务时，启动请求以 `CONTINUATION_UNAVAILABLE` 拒绝；运行时可用但父级缺失或被替换时，以 `UNAUTHORIZED` 拒绝。未实现任何执行方法的提供方会在注册时以 `UNSUPPORTED_CAPABILITY` 被拒绝；请求不受支持的能力会以同一码使创建失败。调用方信号仅取消尚未发布的工作；发布后通过 `dispose()` 取消该次 activation，并等待其后代（包括正在启动的后代）及其资源清理完成。`result` 在清理与通知结束后完成，携带输出、可选结构化数据与停止原因；结果捕获故障在清理后使其拒绝。清理失败使 `dispose()` 拒绝，并将生命周期结束事件标记为失败；结果 promise 与父级通知保留已捕获的执行结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务的构建方式以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **一个服务，多个提供方。** 服务是具名提供方注册表；每个后端以唯一名称注册，请求按名称选择一个。
- **统一受管理生命周期。** `SubagentManager` 统一管理启动、消息准入、容量、父子关系与释放。每条 activation 直接持有本地 AgentHandle 或外部 SubagentRun；本地 inbox 与空闲状态仅属于本地分支。
- **兑现即发布。** `startActivation()` 仅在子级已接受且句柄可取消该次执行后返回。
- **同进程值可信。** 请求、描述符与结果按不可变约定借用；序列化与不可信输入校验属于进程与协议边界。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：提供方注册表、启动与继续 API、生命周期事件 |
| [`src/manager.ts`](src/manager.ts) | 统一管理启动、消息准入、冷恢复、父子所有权、结算与释放 |
| [`src/activation.ts`](src/activation.ts) | 执行期记录、容量槽、子级锁与本地输出捕获 |
| [`src/continuation-messages.ts`](src/continuation-messages.ts) | 相邻 Agent 消息、返回指引与结算通知 |
| [`src/internal.ts`](src/internal.ts) | Host 专用 Queue 与 Steer 适配器，以及标准相邻 Agent 消息标记 |
| [`src/structured.ts`](src/structured.ts) | Activation 局部结构化捕获与保护 |
| [`src/types.ts`](src/types.ts) | 公开的请求、结果与提供方约定 |
| [`src/descriptor.ts`](src/descriptor.ts) | 版本化的 `subagent/descriptor` 会话事件词汇 |
| [`src/catalog.ts`](src/catalog.ts) | parent 自有的 `subagent/catalog` 事件与分块 host projection |
| [`src/child-agent.ts`](src/child-agent.ts) | 子级组装、委派策略、深度辅助函数 |
| [`src/list-children.ts`](src/list-children.ts) | 直接与递归的 parent 目录读取 |
| [`src/control.ts`](src/control.ts) | 浏览器控制请求校验与稳定失败分码 |
| [`src/control-types.ts`](src/control-types.ts) | client-safe 的目录行、控制面请求、回执与失败 |
| [`src/archive-admission.ts`](src/archive-admission.ts) | Workspace 注册表归档准入中的 `subagent` 族：运行中的子孙及其父级取消 |

### 提供方准备与结构化输出

服务在创建前校验请求能力。本地提供方只提供 `prepareContinuable()`：spawn 返回全新状态，fork 返回已完成轮次的初始内容。管理器在创建子级前捕获父级模型设置、委派权限和组合。外部提供方保留 `start()` 作为传输适配器，并保留各自的权限系统；统一管理器拥有已发布的执行。结构化工具、指令、校验与终止保护仅属于一次本地 activation，不作为恢复配置持久化。子代理只能在消费已接受的输入且所属后代释放后提交结构化结果。结果暂存后，在工具结果策略及外层 PTC 执行完成前拒绝继续输入；结果被拒绝后重新开放输入，提交成功后则保持关闭。后续冷恢复不带结构化 schema。

外部提供方为每次执行生成新的 `SubagentRun.id`，在运行时共享的 Session id 命名空间中跨所有父级和提供方保持唯一。与驻留 Agent、Session 或 activation 冲突时，启动以 `DUPLICATE_CHILD` 拒绝，并释放新的外部句柄，不替换已有执行。

### Activation 结算

管理器预留子级身份与容量，创建本地 Agent 或外部执行，并接受初始任务。本地 Agent 活动、待处理输入及所拥有的后代均结束后，管理器在最终 Session flush 后重新验证活动状态并关闭准入。本地与外部 activation 都在句柄清理、容量归还及结算通知结束后交付结果。宿主等待会汇合仍在推进的后代及其清理，包括失败的执行；空闲停放子树继续驻留，但不延迟宿主完成。关闭准入并释放句柄可防止迟到工作进入已释放的 Agent。父级投递在结算后发送通知；调用方投递由等待中的工作流收集。Headless 宿主交替等待 `agent.whenIdle()` 与 `waitForChildren(agent)`，直至没有子级工作，且父级在检查子级期间保持空闲、Session 序号不变，让完成通知可驱动父级生成最终答案。

本地 Agent 发生失败且后续没有成功提交 `turn/end` 时，会在所拥有的后代结束后以 `error` 结算。未认领的输入不会使该失败 activation 一直驻留。后续成功提交的轮次结束记录会取代实时失败，提供恢复后的结果。

本地创建成功后，无论结果交付给谁，都会向父 Session 追加 `subagent/catalog` 事实。外部创建仅在使用 `delivery: 'parent'` 时追加目录事实；调用方拥有的外部执行保留调用方自己的成员记录。外部条目以 `mode: 'external'` 标记没有本地 Session 的子级。目录仅在创建时记录一次成员关系，不携带执行状态。完整结果交给调用方或父级完成通知。投影排除继承事实。直接列表读取一个父级投影，因此已完成的本地工作流子级仍可被发现、打开或继续。Catalog 载荷 v0 记录本地模式，v1 还接受未知模式，v2 记录外部执行，读取器支持三版。历史迁移在 descriptor 不可用时根据可读子 header 追加 v1 `subagent/catalog`；本地创建保留 v0。其 `mode: 'unknown'` 投影让子会话保持可见，但不表示支持继续执行；已有完整条目仍具有权威性。

### 所有权与不变式

- **管理器拥有已接受工作**——未发布的失败会回滚；已发布句柄取消对应 activation，并等待子级优先释放。
- **注册受 effect 作用域约束**——移除提供方会阻止新启动，但绝不撤销已接受的运行。
- **Agent 消息权限基于确切相邻关系**——`sendMessage()` 要求确切在线 sender；每个 sender 都可以指定直接可继续 child，只有具备驻留可继续 Activation 的 sender 可以指定自己的直接 parent。
- **描述符仅进日志**——它是会话事件，不进入模型历史，并跨压缩（compaction）保留；写入器记录解析后的子级提供方、模型与推理强度，用于冷恢复。历史 one-shot 描述符仍可读取。
- **本 runtime 为子代理回答归档准入**（[接缝](../../workspace/workspace/README.zh.md)）——`workspace/session-activity` 把回合中的在线子代理子孙作为 `subagent` 族报告：按本包记录的持久化血缘查找（带 subagent 来源的 `parentSession`，任意深度，从不包括 fork），组合了 Session query 服务时经一次活会话 observation 从各 child 的描述符取名称，否则只报 id；`workspace/session-stop` 以父级原因逐个取消它们，一个拒绝取消的 child 只记日志，其兄弟仍会停止。父级自身的回合、它的任务以及已归档血缘的步骤门禁归 API Session Controller。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享 seam 逐步进入后端、面向模型的工具与设计决策。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [历史Subagent 能力 seam](../../../.agents/notes/archived/feature/2026-06-21-subagent-capability-seam.md)——委派能力家族的设计记录。
- [可继续的 subagent](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)——接受后续轮次的持久子级。
- [进程内 spawn 后端](../subagent-spawn-in-process/README.zh.md)——最容易组合的提供方。
- [Auto review](../../experimental/auto-review/README.zh.md)——只有进程内 DSH 子级继承的当前会话授权模式。
- [进程外 ACP 后端](../subagent-acp/README.zh.md)——经 Agent Client Protocol 拥有自有运行时的子级。
- [DeepSeek 输入转换](../../llm/llm-deepseek/README.zh.md#model-experience)——已保存结算通知的提供方回放规则。
- [tool-subagent-control README](../tool-subagent-control/README.zh.md)——后续消息、中断与列举面。

-----

<a id="model-experience"></a>
## 模型体验

### 结算通知

#### 模型看到什么

父级投递发送包含子级最终输出中非空文本块的 user-role 状态通知，不受 `send_message` 是否可用或是否调用影响。外部通知还说明不支持后续消息。推理及其他非文本块被排除。每条父级通知都会以 `Structured result: <JSON>` 附带可用的结构化输出，并以独立文本块附带提供方安全诊断。收尾文本为空时，通知使用 `It left no closing message.`。调用方投递不发送通知；清理成功时 SDK 生命周期通知保留完整子级输出。

#### Token 影响

父级投递为每个结算的 activation 添加一条通知。调用方投递不添加完成消息，由其消费者负责展示结果。

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

- **后代读取串行执行**——每个可达目录（包括一次性子级）都需要一次观察。冷 Session 缺少有效的 prepared 观察时需要读取完整日志；大型冷会话树可能累积存储延迟。
- **外部子级执行一次**——ACP、DSH SDK、Codex 与 Claude Code 没有本地子 Session，也不接受后续输入。释放后仍可发现父级拥有的执行记录。
- **仅允许相邻模型消息**——`sendMessage()` 要求确切在线 sender；每个 sender 都可以指定直接可继续 child，只有具备驻留可继续 Activation 的 sender 可以指定自己的直接 parent。浏览器提示使用独立的人类 Queue 或 Steer 控制路径。
- **child 到 parent 的投递要求直接 parent 保持在线**——服务没有持久 parent mailbox；parent 缺失时会拒绝消息，而非接受无法唤醒的工作。
- **取消收敛期间存在唤醒缺口**——中断信号发出后、Agent 进入 idle 前被接受的后续消息会保持排队，直到另一条唤醒发送到达。
- **待处理的注入上下文会保留 Activation**——settlement 会保守地把每个 Inbox occurrence 都视为未完成。Agent 进入 idle 后停放的上下文会让 child 及其在线祖先继续驻留，直到唤醒投递将其 claim、queue 变更将其移除，或 manager teardown 将其丢弃。宿主完成检查等待活动工作、待创建子级与资源清理，但不会等待仅包含空闲停放 Inbox 的子树；它既不结算这些 activation 的结果，也不丢弃其消息。
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
