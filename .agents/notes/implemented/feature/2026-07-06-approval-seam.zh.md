# Agent Note: 审批 seam——基于 waterfall（瀑布式事件）应答者的一次性权限决策

Status: implemented

[English](2026-07-06-approval-seam.md) | 中文

## 问题

两个调用方需要同一个封闭决策——「这个具体操作可以继续吗？」：`tools/pre-execute` 的 `ask` 决策（包括 Claude-Code 钩子桥的 `permissionDecision: ask`）以及[沙箱 Agent Note](2026-07-06-sandbox.zh.md) 中拒绝后的一次性升级重试。一个共享的 seam 使它们无需各自发明独立的结果词汇、通道路由、取消机制和审计轨迹，同时保证没有应答者的部署永远不会批准一个无法应答的请求。应答者可以是交互式宿主，也可以是自动化控制器。

路由问题的核心是归属：权限请求必须到达拥有发起请求的 agent（智能体）的通道，对无人拥有的 agent 失败关闭，并且不侵入没有组合应答者的部署。

## 决策

一个包 `dsh-user-approval`（`packages/interaction/user-approval`）负责定义词汇表和 `ctx.approval` 服务——即机制。策略——谁来应答、某个会话是否需要被询问——不在其中：应答者是 `approval/request` waterfall 监听器，由拥有通道的插件注册（ACP（Agent Client Protocol）桥、宿主适配器、测试脚本），而每会话的策略层可以在任何通道介入之前做出决定。消费方（`dsh-tools` 的 ask 路由和沙箱升级门禁）将问题解析为一个封闭结果，并从中派生各自的工具结果。刻意设计为一个包，而非能力 seam 的三包拆分（见「替代方案」）。

### 部署如何使用它

一条 `cordis.yml` 条目挂载该 seam。不加载它就是默认拒绝请求的退出方式：即使没有注册任何审批代码，消费方也会拒绝无法应答的请求。

```yaml
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  # config:
  #   policy: never   # deployment default for sessions without an override; 'ask' when omitted
```

仅有这条条目只提供机制，不提供通道：没有组合应答者时，每次 ask 都解析为 `unavailable`，发起请求的工具调用会被拒绝——无需配置即可做到故障时默认拒绝。组合 [ACP profile 应用](../../../../packages/bundle/acp-app/README.zh.md)即可闭环：其[仅面向自动化的桥接层](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)注册一个应答者，向拥有该会话的客户端发送 `session/request_permission`，携带精确的工具调用 id 和一次性 allow/reject 选项。`policy: never` 是无人值守姿态：每次 ask 都会被确定性地自动拒绝，当前值也会加入运行时上下文快照。`policy` 在插件加载时对照封闭列表校验；非法值直接抛异常。

组合部署的可观测行为：`allowed-once` 仅允许该次调用继续；拒绝、关闭和通道缺失以三种不同原因拒绝，模型可以区分；轮次内成功的请求会在发起请求的 agent 的会话日志上落一对持久化的 `approval/asked`/`approval/decided` 事件；授权不会在发起请求的调用结束后继续存在。空闲时的请求或审计追加失败会拒绝，而不会返回未经审计的决策。

以下是该组合下的一次 ask，取自沙箱示例录制的 `escalation-approved` 场景——模型请求沙箱升级，门禁发起 ask，自动化客户端选择 Allow once：

```
tool/call        bash {"command": "printf 'escalated\n' > escalated.txt && cat escalated.txt",
                       "sandbox_permissions": "workspace-write",
                       "justification": "the user asked to write escalated.txt in the workspace"}
approval/asked   {"toolName": "bash", "callId": "call_00_…",
                  "reason": "escalate sandbox to workspace-write: the user asked to write escalated.txt in the workspace"}
  → session/request_permission {"toolCall": {"toolCallId": "call_00_…"},
                  "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                              {"optionId": "reject-once", "name": "Reject",     "kind": "reject_once"}]}
  ← the client selects "Allow once"
approval/decided {"outcome": "allowed-once"}
tool/result      "escalated" — this one call ran under the wider mode; the grant died with it
```

`escalation-rejected` 孪生场景以 `{"outcome": "rejected"}` 结束：不执行任何操作，模型的结果携带发起方的逐字失败关闭文本（`the user rejected escalating this command to "workspace-write"`）。钩子的 `permissionDecision: ask` 走完全相同的协议；只有发起方和拒绝文本不同（§ dsh-tools 中的 Ask 路由）。没有应答者时，同一请求直接结算为 `unavailable`。

### 设计细节

#### seam：机制与策略分离

经过校验并成功追加 `approval/asked` 后，服务将 `approval/request` waterfall 解析为 `allowed-once`、`rejected`、`cancelled` 或 `unavailable`。服务沿用只读的请求标识和 signal，将中止视为 `cancelled`，把应答者失败和无效返回统一转换为 `unavailable`，丢弃迟到的应答，并追加配对的 `approval/decided` 事件。提交前的审计失败会拒绝；追加后的观察者失败无法撤销权威事件。`allowed-once` 仅授权所询问的操作，而 `request()` 会拒绝进行中的轮次之外的调用，以保证审计对留在持久提交边界内。

应答者是 `approval/request` waterfall 监听器。零监听器会直接落到 `unavailable`；识别该 agent 的监听器占用先到先得的决策槽，而不识别的监听器必须调用 `next()` 委派。监听器会随其 fiber 一同 dispose（资源释放），因此卸载通道后，请求会在故障时默认被拒绝。由于兄弟插件的注册顺序不确定，部署应组合一个终端应答者，并保留 `prepend` 给「决策或委派」门禁。

`ApprovalRequest` 携带发起请求的 `agent`、`toolName`、可选的精确 `callId`、人类可读的 `reason` 和可选的 `signal`。它使用 `ToolCallId` brand 而不导入依赖本 seam 的 `dsh-tools`。通道适配器可按 `callId` 关联任何更丰富的调用状态；审批请求本身不重复携带工具参数。

#### dsh-tools 中的 Ask 路由

`ToolRuntime.execute()` 在派发前解析 `ask`：`allowed-once` 继续执行，而拒绝、取消和通道不可用产生三种不同的拒绝原因。机会性消费 `ctx.get('approval')`，让缺失或未挂载的服务失败关闭而不阻塞注册表 fiber。无 agent 的执行同样失败关闭，因为它既没有审计会话，也没有通道所有者。

#### 每会话策略层

seam 还拥有[沙箱 Agent Note](2026-07-06-sandbox.zh.md) 所描述的会话级 `'ask' | 'never'` 策略。生效策略由日志中记录的切换在部署默认值之上折叠而成。`'never'` 会在任何应答者运行之前，于 `request()` 内部解析为 `rejected`；`'ask'` 则派发请求，否则一路委派至 `unavailable`。两个当前值都会在每次模型请求前加入原子化的运行时上下文快照，因此策略切换无需单独叙述；每次审批请求仍会记录审计对。

#### ACP 应答者

ACP 桥只应答其会话映射所拥有的精确 agent 对象。它携带既有 `callId` 发送 `session/request_permission`，声明一次性的 allow/reject 选项，单独映射取消，并且绝不批准未知选项。不属于该桥或没有调用标识的请求会继续委派；客户端 RPC 失败会转换为 `unavailable`。钩子和 `tools/pre-execute` 决定一次调用是否需要询问。该通道是自动化客户端与其 agent 之间的机器策略，不是 ACP 展示层。

应答者通过[仅面向自动化的 ACP Agent Note](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)描述的桥精确 agent 归属检查进行路由，保留了[多会话 Agent Note](../../archived/feature/2026-06-14-acp-multi-session.md) 要求的每会话权限归属。

#### 审计，以及模型看到什么

`approval/asked` 和 `approval/decided` 是持久的仅日志事件；模型只看到从结果派生出的普通工具结果。成功完成时，每个 `asked` 都提交一个 `decided`，包括取消以及已转换为封闭结果的应答者失败。空闲时的请求不追加任何事件；提交前失败会拒绝，而第二次追加失败可能留下一个已经提交但未匹配的 `asked`。

#### 实体与依赖

`dsh-user-approval` 依赖 Cordis，以及会话、agent 和带 brand 的调用约定；`dsh-tools` 与 `dsh-acp` 消费它。沙箱执行器保持独立，因为升级请求归 `dsh-tool-bash` 所有。固定的派发与审计服务仍是一个包；可替换的应答者留在各自的通道所有者中。静态能力授权和 `subagent-acp` 子侧权限应答仍是独立关注点。

### 测试

单元测试锁定结果、先到先得的委派、错误转换、取消、作用域路由、审计配对、不可绕过的 `'never'` 策略、工具拒绝原因，以及通过真实脚本化桥实现的 ACP 归属／结果映射。

快照记录通过 `session/request_permission` 批准和拒绝沙箱升级，以及完整的 `'ask'` 与 `'never'` 运行时上下文贡献。没有脚本化应答的权限提示会取消并失败关闭。

## 延后

- **`allow_always` 授权存储**：兑现持久授权意味着设计存储、作用域标识（调用？路径？前缀？会话？时间窗口？）和撤销；在设计完成之前，只展示一次性选项（[沙箱 Agent Note](2026-07-06-sandbox.zh.md) § Escalation 记录了开放的作用域问题）。
- **通过组合应答者录制由钩子驱动的 `ask`**：权限协议格式（wire format）已通过沙箱示例的升级分支录制。钩子矩阵中的 `hook-cc-pretool-ask` 固定无 ApprovalService 时的后备拒绝，而钩子生产者与应答者的组合仍留在单元测试层。
- **将子 agent 的审批路由到父会话**：`subagent-acp` 的子侧自动应答自己的权限请求；将其委派给父控制器是独立的设计。

## 曾考虑的替代方案

- **单一注册提供方而非 waterfall 监听器**：否决。`registerProvider()` API 迫使所有组合问题——允许列表预过滤、外部钩子决策者、脚本化测试应答、人类前面的策略门禁——都塞进一个提供方实现。waterfall 直接复用运行时已有的组合能力、缺失时默认拒绝行为和 HMR（热模块替换）资源释放机制；seam 的 JSDoc 以约定固定单决策槽语义，而非发明一个提供方注册表。
- **在 ACP 桥中内联 `tools/pre-execute` 权限门禁**：否决。对桥拥有的每次调用都弹出提示，会将请求策略硬编码进传输层，无法服务第二个发起方（沙箱升级发生在执行开始之后，没有 pre-execute 时刻），且钩子产生的 `ask` 决策没有共享机制。
- **通用用户交互 seam（`ctx.userQuestions`）**：否决作为审批机制。二者骨架相似（按 agent 路由、阻塞等待人类、处理缺失），但审批的约定在每个关键维度上都更窄：封闭的结果词汇而非自由文本、附着在工具调用上的协议原生提示而非通用表单、强制的缺失时失败关闭、以及审计事件。因此审批不走已交付的 `packages/interaction/user-questions` / `ask_user_question` 信息征集路径——信息征集表单不是权限提示，自由文本应答不是封闭结果；如果二者将来趋同，共享提供方管道仍然开放。
- **`dsh-tools` 中的静态可选注入**：否决。vendor 的 Cordis `Inject` 类型没有 optional 标志——对象形式将服务名映射到拦截配置，声明的 inject 会阻塞 fiber。`ctx.get('approval')` 是文档化的机会性消费模式（`tool-bash` 的 owner-token 查找、loop 的持久化探测），按调用读取存在性，跨 HMR 正确降级，无需额外机制。
- **能力 seam 的三包拆分**：否决。Service Definition/Service Provider/Consumer 适合 Service Provider 可替换的 seam（bash-local vs bash-sandbox）。此处服务体是固定机制，可变部分是留在各自通道拥有者插件中的监听器——拆分只会制造一个空的 Service Provider 包（「不要预防性拆分」）。
- **现在就提供 `allow_always`**：否决。协议能表达它，但兑现它意味着设计授权存储、作用域标识和撤销（§ 延后）。展示 harness 无法兑现的选项只会制造注定失败的授权。

## 后果

实现后的约定由「测试」一节所列套件固定：

- `allowed-once` 派发一次操作；其他所有结果都以不同原因拒绝，而 `'never'` 会在提示前拒绝。
- 缺失、外部、无 agent、抛异常、无效或断开连接的应答路径都会失败关闭。
- 成功的请求按精确 agent 归属路由，并追加一对可回放、对模型不可见的审计事件；空闲时和提交前失败的请求会拒绝。
- ACP 归属把决策限制在其会话内，而没有该服务的部署不产生请求或审计事件。

代价与已接受的局限：

- **两个都会直接作出决策的应答者会竞争同一槽位。** 兄弟插件的监听器顺序不确定，seam 无法仲裁竞争的终端应答者。通过约定缓解（每个部署一个终端应答者；仅对「先决策或委派」门禁使用 `prepend`），而非事件总线不具备的优先级机制。
- **生产路径仅在一种组合下得到验证。** `ask` 有两个生产者家族——钩子桥通过 `tools/pre-execute`，沙箱升级通过自己的门禁——协议格式录制在沙箱示例的快照套件中；因此在更多部署组合它之前，seam 的真实覆盖面就是这一种组合。
- **归属以 `Agent` 对象标识为键。** 应答者先在 `agent.session.id` 处解析会话映射记录，再要求该记录拥有精确的 agent 对象；当前所有路径在 loop 和各 seam 之间传递同一对象，但未来如果某个边界克隆或代理了 agent，桥会委派并失败关闭，届时需要另一种归属约定。

## 常见问题

- **在完全没有应答者的部署中（headless、CI）会发生什么？** 每次 ask 都会沿空的 waterfall 落到 `unavailable`，工具调用以「no approval channel is available」原因被拒绝。失败关闭是零监听器的默认行为，不是配置。
- **授权能持久化吗——「始终允许」？** 不能。`allowed-once` 仅授权单次被询问的操作，服务在请求之间不存储任何内容；`allow_always` 在授权存储设计完成之前刻意不展示（§ 延后）。
- **模型看到审批的什么？** 只看到发起方从结果派生的工具结果——审计对永远不进入 transcript（文本记录）。三种非授权原因各不相同，模型可以区分人类说「不」、提示被关闭、通道缺失。
- **谁决定一次调用是否需要 ask？** 策略生产者：返回 `permissionDecision: ask` 的钩子、任何 `tools/pre-execute` 监听器、或沙箱升级门禁。seam 和桥只负责路由和应答；二者都不注入自己对「什么值得弹出提示」的判断。
- **用户关闭提示或轮次在 ask 进行中中止时会发生什么？** 关闭映射为 `cancelled` 并携带自己的拒绝文本。已中止的 signal 直接结算为 `cancelled` 而不派发；ask 进行中的中止丢弃迟到的应答。当两个审计追加都提交时，任一路径都记录恰好一对事件，绝不会两对。
- **如果客户端以 harness 从未提供的选项应答呢？** 除已提供的 `allow_once` 之外的任何选项都映射为 `rejected`——来自不合规客户端的未知 optionId 永远不能授权。
- **subagent 的审批如何路由？** 不路由：委派会把每个进程内子 agent 钉定为 `'never'`（[审批钉定决策](2026-08-10-subagent-approval-pinned-never.zh.md)），因此子 agent 的每次 ask 都在任何应答者之前解析为 `rejected`，子 agent 则通过其运行时上下文一开始就会得知。`subagent-acp` 的子侧自动应答是独立的；将子 agent 的 ask 路由到父控制器已延后（§ 延后）。
- **`policy: 'never'` 在运行时实际改变了什么？** 服务在派发任何应答者之前，将该会话的每次 ask 解析为 `rejected`（在服务内部，因此没有注册顺序能绕过它）；下一份原子化的运行时上下文快照会声明该策略；每次成功的自动拒绝都会记录审计对。
- **热重载或应答者在会话中途卸载时会发生什么？** 应答者随其拥有的 fiber 一起 dispose，因此下一次 ask 降级为 `unavailable` 而非挂在死通道上；重新挂载会重新注册应答者，无需追赶状态。
- **客户端从哪里获得审批上下文？** 请求携带精确的 `callId` 和发起方的人类可读 `reason`；通道适配器可自行关联更丰富的工具调用状态，而无需在审批 seam 中重复携带参数。

## 先例

本设计复用或对照的仓库内先例：

- `fs/write-intent` 门禁（`packages/fs/fs/`）——文档化的单占用决策槽 waterfall 语义（先到先得，通过 `next()` 委派），应答者约定复用了它。
- `hook/invoked`/`hook/result`——仅日志审计对先例，`approval/asked`/`approval/decided` 沿用了它；[钩子桥 Agent Note](../../archived/feature/2026-06-30-hook-bridges.md) 交付了 `permissionDecision: ask`，即第一个生产者。
- [拦截扩展点 Agent Note](2026-06-30-interception-extension-points.zh.md)——`tools/pre-execute` 的 `allow`/`deny`/`ask` 词汇，本 seam 服务其中的 `ask`。
- [仅面向自动化的 ACP Agent Note](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)——应答者路由时对会话映射执行的精确 agent 归属检查；[多会话 Agent Note](../../archived/feature/2026-06-14-acp-multi-session.md)——本设计实现的每会话权限归属阻塞项。
- 机会性 `ctx.get()` 消费模式（`tool-bash` 的 owner-token 查找、loop 的持久化探测）——`dsh-tools` 消费该 seam 而不阻塞其 fiber 的方式。
