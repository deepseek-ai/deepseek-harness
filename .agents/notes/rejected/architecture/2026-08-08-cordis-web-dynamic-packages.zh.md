# Agent Note: Cordis Host/Client 动态插件运行体系

Status: rejected — closed as a proposal: the shipped packages/extensions runtime and its READMEs own the design

[English](2026-08-08-cordis-web-dynamic-packages.md) | 中文

## Problem

模型需要在不修改仓库源码、不重新构建应用、不刷新浏览器的前提下，临时扩展当前 DSH 进程。扩展既可能运行在 Host 的 Node.js 进程，也可能运行在 Client 浏览器页面，还可能由 Host 取数、Client 展示，共同组成一个插件。

这项能力不能只是“执行一段代码”。模型需要在写代码前发现两端允许使用的 Service、Event、Builtin、Slot 和主题 token；用户需要先预览代码，再决定是否允许 Client 代码进入页面；同一个插件需要追加不可变版本、失败后重试或回退；运行后的异步错误需要回到模型，而不是只留在服务端日志或浏览器控制台。

如果把定义、审批、运行、版本切换、能力发现和 UI 状态塞进一个动作，会产生无法稳定解释的状态：定义成功是否等于运行成功，升级失败后哪个版本仍是成功版本，页面没有响应时 Tool 应等待多久，同一个 Package 多次运行时哪张历史卡片承载业务 UI，以及 Client 页面局部装载状态是否能代表 Host 的进程级状态。

## Proposal

### 核心原则

- Host 保存 Plugin、Package、Run、审批和版本指针的唯一进程级权威状态。
- Client 只保存当前页面的审批交互、装载结果、Slot 贡献、业务视图和页面局部错误。
- Define 只创建不可变代码版本；Run 只激活一个已定义版本。
- 版本切换只有在目标 Package 完成要求的 Host/Client 激活后才提交 `currentPackageId`。
- 模型写代码前通过 Inspect Provider 查询能力；Inspect 结果只辅助编码，不作为插件运行时业务数据。
- Host 与 Client 动态代码都使用受限的 plain JavaScript 上下文，并把可撤销副作用挂到 Cordis 生命周期。
- Client 代码进入页面前需要用户授权；授权范围可以是单个 Package，也可以是同一 Plugin 的后续版本。
- Tool 调用不等待当前轮结束后才可能发生的审批或浏览器操作；异步结局通过状态存储和模型 steering 反馈。

### 包职责与依赖方向

动态运行体系由 `packages/self-modification/` 下四个包组成：

| 包 | npm 包名 | 职责 |
| --- | --- | --- |
| `tool-cordis` | `@deepseek-ai/dsh-tool-cordis` | 注册 System Prompt、七个模型 Tool、Host Inspect Provider、`@pluginId` 上下文注入和 Tool 展示元数据 |
| `cordis-host-runner` | `@deepseek-ai/dsh-cordis-host-runner` | 保存权威 Registry，分配 ID，执行 Host 代码，管理版本、审批、Run、私有 handler、Inspect 路由和模型反馈 |
| `cordis-client-runner` | `@deepseek-ai/dsh-cordis-client-runner` | 在浏览器同步 Inspect manifest，编排审批后的 Host→Client 激活，求值 Client 代码，管理 Guard、Loader/Fiber、timer、样式和 teardown |
| `ui-cordis` | `@deepseek-ai/dsh-client-ui-cordis` | 展示 Define/Run Tool 卡片、全局 Cordis 面板、审批控件、版本选择、运行状态和 Package 自定义业务视图 |

`tool-cordis` 只依赖 Host Runner 的进程内服务，不导入 Client 实现。`ui-cordis` 只消费 Client Runner face 和 Client-safe wire 类型，不导入 Host 实现。Host 与 Client 的运行控制通过已有生成 Remote 面和转发事件连接，网关不拥有动态 Plugin 的领域逻辑。

### 领域对象

#### Plugin

Plugin 是可持续修改的动态插件实例，由品牌类型 `CordisDynamicPluginId` 标识，例如 `clock-1`。新建 Plugin 时，模型只提交 3 至 6 位小写英文语义前缀；Host 添加进程内唯一数字后缀。完整 `pluginId` 不能由模型指定。

Plugin 属于定义它的 Session。模型 Tool 只能读取和操作当前 Session 的 Plugin；全局 Client 面板可以列出所有 Session 的 Plugin，但每个动作仍使用该行携带的 owner Session 执行。

#### Package

Package 是 Plugin 下的不可变代码版本，由 `CordisDynamicPackageId` 标识，例如 `pkg-2`。它包含名称、用途、可选 Host 代码和可选 Client 代码，且至少包含一侧。每次 `cordis_define` 都创建新 Package；已有 Package 不允许原地修改。

同一个 Plugin 可以拥有多个 Package，但同一时刻最多只有一个物理 Run。Package 是否含 Host 或 Client 半只决定激活步骤，不改变版本身份。

#### Plugin Run

Plugin Run 是一次具体激活尝试，由 `CordisDynamicPluginRunId` 标识，例如 `run-3`。每次新的激活尝试都会分配新 ID，包括审批后失败、重试同一 Package 和版本更新。`pluginRunId` 把审批、Host 激活、Client 装载、私有 RPC、Tool 卡片和错误关联到同一次尝试。

Host 分开保存当前物理 Run 与 `latestRun`。物理 Run 表示此刻仍可调用和撤销的激活；`latestRun` 表示最近一次尝试的审批、阶段、两侧状态和诊断。一次失败可以没有存活的物理 Run，但仍留下可查询的 attempt。

#### 版本指针

- `currentPackageId` 是最近一次完成要求的激活流程的 Package。停止插件、开始更新或更新失败都不清除它。
- `nextPackageId` 是正在等待审批、正在激活、等待 Client、或最近失败的目标 Package。目标成功提交为 current 后清除。

Host-only Package 在 Host 成功建立 Fiber 后提交 current。包含 Client 的 Package 在 Host 激活成功且至少一个 Client 成功建立对应装载后提交 current。因硬依赖缺失而被 Cordis park 为 waiting 的 Fiber仍是成功建立的生命周期对象，不等同于解析或 `apply` 失败。

更新目标失败时不自动重启旧物理 Run。旧 `currentPackageId` 继续表示最后成功版本，失败目标保留为 `nextPackageId`。用户或模型可以重试 next，也可以以 `mode: "run"` 重新激活 current 完成回退。

### Host 权威状态与持久性

`DynamicCordisRunnerService` 及其内部 Registry 是当前 DSH 进程内的唯一权威，保存：

- Plugin 的 Session 归属和不可变 Package 集合；
- `currentPackageId`、`nextPackageId`、物理 Run 和 `latestRun`；
- 单 Package 授权与 Plugin 跨版本授权；
- 待处理的 Client 激活请求；
- Host Fiber、Package 私有 handler、等待中的 Service 和最近诊断；
- Host 与 Client Inspect Registry 的目录和查询路由。

这些对象不写入配置或磁盘，也不在进程重启后恢复。Session Log 可以保留 Tool 调用、结果和卡片所需元数据，但不会重放动态代码来恢复 Registry。进程重启后历史卡片仍可作为对话记录存在，原 `pluginId` 和 `packageId` 不再可运行。

运行态不作为可恢复状态写入 Session projection。页面刷新或新页面打开不会自动恢复 Client 半；自动恢复会重新引入连接身份、启动期 baseline 和跨页面一致性协议，不属于当前设计。

### Define、Run 与版本切换

`cordis_define` 有两种模式：新建 Plugin 时提交 `idPrefix`；修改现有 Plugin 时提交精确 `pluginId`。代码统一为 `code: { host?, client? }`。Define 只校验参数和 plain JavaScript 语法，记录不可变源码并返回最终 ID。它不执行 `apply`、不产生审批、不改变版本指针，也不隐式运行。

不提供独立 `cordis_update`。`cordis_run` 通过 `mode` 表达激活意图：

| 版本关系 | `mode` |
| --- | --- |
| 尚无 `currentPackageId` | `run` |
| 目标等于 current，包括重启、重试或回退 | `run` |
| 目标与已有 current 不同 | `update` |
| 更新失败后重试 `nextPackageId` | `update` |

Run 先验证 Plugin/Package 归属、版本关系和是否已有转换在进行，再创建 `pluginRunId`、写入 `latestRun` 和 `nextPackageId`。

Host-only Package 在 Tool 调用内完成 Host 激活，并同步返回 `running` 或失败。包含 Client 的 Package不在 Tool 调用内等待浏览器终局：未授权时登记审批并返回 `awaiting-approval`；已授权时登记自动 Client 激活并返回 `starting`。这两种返回都表示请求已建立，不表示完整激活成功。

目标真正开始激活时，Host 先停止旧物理 Run，再执行目标 Host 半。Host 成功后才允许 Client 获取精确 `pluginRunId` 对应的源码并装载。Client 成功后 Host 提交版本指针；任何阶段失败都记录到该 attempt，不把旧版本重新启动伪装成目标成功。

`cordis_stop` 撤销当前 Host/Client Run 及待审批请求，但保留 Plugin、Package、授权和版本指针。`cordis_undefine` 先停止，再删除 Plugin、Package、授权和版本指针；删除后历史卡片只显示“插件已移除”。

### Client 审批与授权

包含 Client 代码的 Package 在第一次激活前需要用户授权，因为它将在用户页面中运行模型生成的代码。审批面板提供三个动作：

- 单勾允许当前 Package；同一 Package 后续重跑不再审批，新 Package 仍需审批。
- 双勾允许当前 Plugin 的后续版本；新 Package、更新、重试和回退不再逐版本审批。
- 拒绝结束当前请求，不执行 Host 或 Client 代码；模型不得在用户没有新要求时立即重复申请。

授权在用户允许时写入 Host Registry，即使随后发生技术失败也保留。面板直接运行 Package 时，用户点击本身授权该 Package。

待审批行只显示单次允许、跨版本允许和拒绝，不同时提供运行、停止或删除。发现新审批时面板自动展开；自动展开失败或被收起时，固定入口和行状态仍显示待审批数量与状态。

### Client 激活编排

Host 通过 `cordis/request-run` 发送 Client 激活请求。请求只包含请求身份、Session、Plugin、Package、mode、名称、用途和是否需要审批，不广播源码。

获得授权的页面按固定顺序执行：

1. 调用 `runHostHalf`，启动目标 Host 半或绑定同一次 attempt 已启动的 Host Run。
2. Host 成功后，以 `pluginId + pluginRunId` 调用 `getClientCode`，只取得当前精确 Run 的 Client 源码。
3. Client Runner 在页面求值插件，建立 Loader entry/Fiber，安装 Guard、样式、Slot 和页面局部状态。
4. 页面调用 `resolveRequestRun` 或 `settleUserRun` 回报成功、waiting 或失败。
5. Host 接受仍有效的精确 Run 回报，提交 current 或保存诊断，并广播请求结束，其他页面清理活动。

Host 激活先于 Client，避免 Client 在所需 Host handler 尚未存在时启动。只有本次请求实际创建的 Host Run 才能因本页 Client 失败而撤销；只是绑定既有 Run 的页面没有其所有权。

Client Orchestrator 按 `pluginId` 保存待审批和正在编排的活动，同一个 Plugin 不并发执行两次页面激活。Host inventory 可重建遗漏的待审批项和无需审批的自动激活请求。

Client 装载状态是页面局部事实。Host active 不代表当前页面已装载 Client 半。UI 使用三种主要状态：无物理 Run为灰色“待激活”，Host 已运行但当前页面 Client 未成功装载为黄色“Client 待激活”，当前页面两侧可用为绿色“运行中”。审批中和失败作为额外状态显示。

当前版本不建立 per-connection 身份或多页面法定人数。第一个仍有效的 Client 成功回报可以提交进程级 current；其他页面是否装载由各自页面 store 表示。

### Package 私有 Client→Host 通信

动态 Package 通过私有 JSON 通道从 Client 调用 Host：Host 使用 `harness.handle(method, handler)` 注册当前 Run 的方法，Client 使用 `host.call(method, args)` 调用。每次调用关联 `pluginId + pluginRunId`，Host 拒绝已停止或过期 Run。参数和返回值必须是无损 JSON，不允许函数、React 元素、Context、Service 实例或类对象。

该通道只服务同一 Package 的 Client→Host 调用，不使用公开 Remote Service 或动态代码中的 `ctx.remote`。公开 Remote 面只承载 Runner 自己的控制协议，不向动态 Package 暴露。

### 动态代码、Guard 与生命周期

Host 和 Client 都只执行 plain JavaScript 函数体，不经过 TypeScript、JSX 或 bundler 转译。Host 运行在 `node:vm`，Client 在受限闭包中求值。两端上下文用于减少误用并提供教学错误，不是恶意代码安全边界。

模型默认通过 `ctx.get('serviceName')` 读取可选 Service 并判断 `undefined`。只有 Service 是硬依赖、缺失时 Package 必须 waiting 并在 Service 出现后重新激活时，才在插件对象声明 `inject`。直接访问 `ctx.serviceName` 只在同一插件声明对应 inject 时允许。

Host 与 Client 的 `timer` 都是同名 Cordis Service，使用一致接口，不是全局 Builtin。需要 timer 的插件必须声明 `inject: ['timer']`；React effect 中创建的 timer 把 disposer 作为 cleanup 返回。

所有注册和可撤销副作用由当前 Fiber 拥有。Event listener、Service、Tool、handler、timer、Slot、样式和主题覆盖通过 `ctx.effect()`、`ctx.on()` 或返回 disposer 的官方 API 注册。停止、更新、失败回滚或 undefine 时撤销两端贡献。Theme override 必须按 source 分层并返回 disposer，使卸载后恢复此前主题值。

宿主、DSH、Cordis 及其 Service、Event payload、Slot props、Session/Conversation Snapshot、Tool 状态和其他运行时对象是内部 live data。动态代码不得对这些对象或其子对象执行 `JSON.stringify`、`structuredClone`、递归枚举、全量复制或整体展示；只能读取当前任务所需叶子字段，构造不含宿主引用的最小自有数据。

### Inspect Provider 与 Catalog

能力发现分为三个 Tool：`cordis_inspect_list` 列 Host/Client Provider manifest；`cordis_inspect_query` 执行指定平台的显式只读查询；`cordis_inspect_self` 查询当前 Session 的 Plugin、Package、源码、版本指针和运行诊断。

Host 和 Client 各自拥有 `CordisInspectRegistry`。Provider 注册平台内唯一 ID、说明、method、输入 schema 和输出 schema。Provider method 是显式白名单查询，不是任意 Service 方法透传；Registry 不维护分层 target，也不自动把业务 Service 方法变成可执行 Inspect method。

首批 Provider 为：

| Platform | Provider.method | 数据来源 |
| --- | --- | --- |
| Host / Client | `Service.listService` | 各平台 Service 静态 Catalog |
| Host / Client | `Event.listEvents` | 各平台 Event 静态 Catalog |
| Host / Client | `Builtin.listBuiltins` | evaluator/Guard 附近的手工定义 |
| Host | `Tool.listTools` | 当前 Agent 真正可见的 Tool Registry |
| Client | `Slots.listSubTree` | Slot 静态 Catalog与页面 live subtree/occupants |
| Client | `Theme.listTokens` | ThemeService 的只读 inspect export |

Client Registry 变化后向 Host 同步完整 manifest，不按 Session 保存重复目录。Host query 本地执行；Client query 由 Host 广播 request ID，页面调用本地 Provider 后回送。Host 只接受第一个通过输出 schema 校验的成功结果；失败页面不抢占请求。没有页面成功回答时 Tool 保持 pending，直到后续成功或 Tool call 取消。

Inspect 数据只用于写代码前确认能力、签名、类型和挂载协议。插件运行时需要业务数据时必须调用实际 Service 或监听实际 Event，不能缓存、展示或依赖 Inspect/Catalog 返回值。

`CordisCatalogProjector` 使用 TypeRT 分别生成 Host/Client Service 与 Event Catalog；Slot AST 生成器扫描 `SlotMap`、注册选项、standard props、owner props 和引用类型；Slots Provider 查询时合并静态 Catalog 与 live tree。Theme token 由 ThemeService 导出，Builtin 在 evaluator/Guard 附近手工维护，Tool schema 来自 Registry。

Catalog 扫描真实源码签名，再应用 model-visible 白名单。白名单可以隐藏 Service、成员、`@deprecated` API、Runner 自身服务和 `cordis/*` 控制 Event，但不能改写剩余 API 的方法名、参数和返回类型。Guard 可以拒绝参数、固定来源或屏蔽成员，但必须尊重源码签名。

模型可见 owner JSDoc 只要求完整 description、每个参数的 `@param`、非 void 返回的 `@returns`、Event 的 `@mode`，以及 Slot/props 字段说明。调用推荐、反例和跨能力选择放入 Skill，不在 Catalog 增加重复 example 字段。

### 模型指导分层

模型指导分为四层：

- System Prompt 保存稳定运行模型、两端限制、生命周期、审批、版本指针、最低代码规范和七个 Tool 的使用地图。Skill 不可用时它仍须支持最低限度正确实现。
- `cordis-plugin-development` Skill 保存需求导航、能力组合、推荐和反例，不复制完整 schema。
- 每个 Tool description 只说明该动作的前置条件、参数语义、同步/异步结果和下一步。
- Provider/Catalog 返回当前精确名称、签名、参数、Slot props、token 和运行时查询结果。

System Prompt 要求先加载 Skill，再 list/query，之后 define/run。Skill 中 React 示例必须注册到 Slot，不能从 `apply()` 直接返回 React Element；示例使用 `React.createElement`、正确 `ctx.get()`/`inject`、可逆 effect 和最小 JSON RPC。

### `@pluginId` 与 Tool UI

输入系统为当前 Session 注册 `@pluginId` mention。选择后只注入 Plugin 身份、默认基准 Package、版本指针、活动 Run 和最近状态，不注入源码。默认基准依次选择 next、current、最近定义的 Package。模型必须先用 `cordis_inspect_self` 读取源码，再以 existing 模式追加 Package；引用失效时不能静默创建替代 Plugin。

`cordis_define` 卡片以 Host/Client 两个子页签展示代码。`cordis_run` 卡片由 `pluginRunId` 关联精确 attempt，并读取 Client store 显示待审批、Client 待激活、运行中、失败、已被后续 Run 替代或 Plugin 已移除。

Package 可以向 `tool.view.cordis` 注册 `key: "self"`。运行时把 self 绑定为 `pluginId + packageId`；业务 Slot key 不含 `pluginRunId`，但 owner props 仍提供精确 Run 身份。同一 Package 最新 Run 卡片承载业务 UI，更早卡片显示已有更新运行。卡片通过 store 响应变化，不扫描后续 Session Log，也不互相通知。

全局 Cordis 面板使用一个固定入口，按当前会话和其他会话分组。面板标题和收起操作固定，只有列表滚动。普通行可选择 Package并运行、停止或删除；失败更新可重试 next 或选择 current 回退；待审批行只提供两个允许动作和拒绝。

### 错误与模型反馈

跨 Host/Client 的技术错误保留原始 `message`，并在错误对象提供时保留 `stack`。结构化诊断包含 `pluginId`、`packageId`、`pluginRunId` 和阶段：approval、host-load、host-apply、client-load、client-apply 或 client-render。

Host/Client Guard、Host 求值与 handler、Client 求值与 apply、Slot `onEntryError` 和 React ErrorBoundary 都把错误回到 owning Agent。Client 控制台同时以 `console.error` 打印原始 error 对象。渲染错误属于精确 Run，不污染不可变 Package。

模型发起的异步 Run 在成功、拒绝或技术失败后使用 `agent.steer` 唤醒 owning Agent。技术失败要求读取诊断、在同一 Plugin 修正并自主重试；用户拒绝则禁止自动重复申请。用户在面板手动运行、停止或移除通过 context injection 告知下一 step，但不主动唤醒模型。

## Alternatives considered

**Define 与 Run 合并。** 这会失去“已定义但未运行”的可预览状态，把语法错误、审批、运行错误和重试混成一个动作，因此拆为不可变 Define 和独立 Run。

**Package ID 同时作为 Plugin ID。** 单层 ID 无法表达稳定实例下追加不可变版本，更新只能 stop、undefine、重新 define，历史卡片和 `@` 引用也无法保持同一对象，因此采用 Plugin、Package、Run 三层身份。

**提供独立 `cordis_update`。** Update 的装载、审批、UI、诊断和 Run 相同，独立 Tool 只复制协议，因此合并到 `cordis_run mode:"update"`。

**更新失败后自动恢复旧物理 Run。** 自动恢复会把“目标失败”和“旧版本重新成功”混成一个结果。当前设计保留旧 current 指针但不自动重启，让用户明确选择重试 next 或 run current。

**让 `cordis_run` 阻塞到用户审批和 Client 终局。** 审批或页面操作可能只能在当前模型轮结束后发生，阻塞会形成死锁，并在无页面时无限占用 Tool。当前设计立即返回，通过 store、Inspect 和 steering 报告终局。

**Host 广播源码并用超时等待 Client ack。** 广播会在授权前把代码发给所有页面；超时无法区分没有页面、页面慢和用户未操作；Host 还要维护补偿式回滚。当前协议只广播元数据，由获准页面按精确 Run 拉取源码。

**页面启动时自动恢复所有 Host active Package。** 这要求连接身份、启动期 baseline 和跨页面一致性。当前设计接受页面局部 Client 状态，用户可在面板重新装载。

**通过公开 Remote Service 或 `ctx.remote` 连接 Package 两半。** 这会把动态 Package 暴露到产品级 RPC 面。Package 私有 `harness.handle`/`host.call` 足以承载 Client→Host JSON 调用，并能按 `pluginRunId` 拒绝陈旧请求。

**把所有 Service 方法自动暴露成 Inspect query。** 这会把能力发现变成业务调用代理，绕过插件审批和生命周期。Provider 只暴露策展的只读查询，Service Catalog 只描述业务方法签名。

**把完整 API 写进 System Prompt 或 Skill。** 固化文本会漂移并占用上下文。System Prompt 保留稳定规则，Skill 负责需求导航，精确签名和运行时目录由 Provider/Catalog 返回。

**要求 Slot owner 在运行时注册 props schema。** Slot props 已存在于 TypeScript 类型和 JSDoc 中，重复注册会制造第二份权威。当前设计用 Slot AST Catalog 提取静态协议，只在查询时合并 live tree。

**把运行态写入 Session Log 并在 replay 恢复。** 动态代码和 Fiber 是进程局部对象，恢复要求重新执行历史代码并重新解释审批。Session 只保留模型可见记录，Registry 和页面 Run 不恢复。

**让历史 Run 卡片扫描后续 Session Log。** 这会让 Tool view 依赖全量日志顺序和后续消息结构。页面 card index/store 已能按 Package 告知旧卡片被替代或 Plugin 被删除。

## Acceptance criteria

- 新 Plugin 只能由 3 至 6 位小写英文前缀创建，最终 Plugin、Package 和 Run ID 由 Host 分配并使用品牌类型。
- `cordis_define` 只做参数和 plain JavaScript 语法检查，返回不可变 Package；同一 Plugin 可以追加版本，旧源码保持可 inspect。
- `cordis_run` 严格校验 run/update；Host-only 同步完成，Client-bearing 返回 `awaiting-approval` 或 `starting`，不等待页面终局。
- 单勾只授权当前 Package，双勾授权同一 Plugin 后续版本；授权在技术失败后仍保留，拒绝不执行两侧代码。
- Host 先激活，Client 后取精确 Run 源码；Client 成功前不提交 Client-bearing Package 的 current，失败后 current/next 可用于重试和回退。
- 一个 Plugin 同时最多一个物理 Run；stop 撤销两端贡献但保留定义和指针，undefine 删除全部 Package、授权和状态。
- 当前页面能区分“待激活”“Client 待激活”和“运行中”，待审批时只显示审批动作。
- `tool.view.cordis` 的 self 绑定 Plugin + Package；同 Package 最新 Run 卡片独占业务 UI，旧卡片和已删除 Plugin 有明确退化状态。
- Host/Client Guard 拒绝 import、JSX、未声明 Service 和不可用全局；Service、timer、Slot、样式、Tool、handler 和主题覆盖随 Run teardown。
- Package 私有 RPC 只允许 Client→Host 无损 JSON，并拒绝陈旧 `pluginRunId`。
- Inspect list 一次返回 Host/Client manifest；query 只调用显式只读方法，Client 查询等待首个 schema-valid 成功结果或取消。
- Service/Event Catalog 分 Host/Client 生成并应用白名单，`@deprecated` API、Runner 自身服务和 `cordis/*` 控制 Event 不向模型暴露；Slot query 合并静态 props 与 live subtree。
- `cordis_inspect_self` 分层返回列表、Package 摘要和精确源码/诊断；`@pluginId` 不直接注入源码且更新留在同一 Plugin。
- 异步技术失败、Host handler、Client Guard 和 React 渲染错误保留 message/stack 并 steering owning Agent；用户面板操作只注入下一 step context。
- System Prompt、Skill、Tool description 和 Provider/Catalog 按本 Note 分层，Skill 不可用时 Prompt 仍足以生成最低限度正确的插件。
- 相关工作区 `pnpm run build` 通过；实现阶段补齐 Host/Client lifecycle、版本、审批、Inspect、Guard、Tool 卡片与真实应用快照覆盖。

## Risks

- **进程重启丢失全部动态对象。** 历史 Tool 卡片仍在，但 Registry 不恢复；用户必须重新 define。
- **多页面状态不是强一致系统。** 第一个有效 Client 成功结果可以提交 current，各页面的 Client 装载和渲染状态仍可能不同；当前不引入连接身份、法定人数或页面聚合。
- **Client Inspect 可能长期 pending。** Host 保存最近 manifest，但没有页面成功执行 Provider 时不能用旧数据伪装 live 结果；多个页面都失败时请求等待到取消。
- **跨版本授权扩大信任范围。** 双勾允许同一 Plugin 后续 Package 无需再次审批；UI 必须清楚区分单次和跨版本授权。
- **失败更新可能留下 current 指向旧版本但旧版本未运行。** current 表示最后成功版本，不表示当前物理 Run；UI、Inspect 和提示必须同时展示 active、current 和 next。
- **受限上下文不是安全沙箱。** Host Service、文件、命令、网络和 Client UI 都是真实能力；白名单与审批降低误用，不隔离恶意代码。
- **Catalog、Guard 和源码可能漂移。** 生成器、白名单和 owner JSDoc 必须共同维护；Guard 的隐藏策略不能产生另一套签名。
- **Builtin 依赖手工声明。** React、harness、host、styles 和 Context 方法没有统一可扫描入口，注入实现与 Provider 定义必须放在同一维护位置。
- **Provider 输出 schema 当前允许较宽的 JSON。** 首版优先完成 Provider 所有权、输入校验和 Host/Client 路由；更窄的输出 schema 后续再收紧。
- **Host 与 Client Guard 存在平行实现。** 两侧开放环境和 Cordis 类型面不同，当前保留各自实现；公共规格只有在能减少代码且不隐藏安全策略时再提取。
