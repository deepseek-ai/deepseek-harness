# Agent Note: Client Session 引用、引用来源与 UI 状态

Status: implemented

[English](2026-09-15-client-session-references.md) | 中文

## 问题

Session 目录、活跃 Client 对象、视图与异步操作具有不同生命周期。目录成员关系不能证明仍在使用。借用的 binding 无法保护异步工作，也无法区分同一 Session ID 的不同 Client 代。全局 current Session 会使独立绑定的组件操作另一个视图的 Session。

引用计数能表明仍在使用，但不能识别使用方。主区域高亮、Sidebar 所有权与后台操作需要使用方来源信息。待处理交互与完成提醒也需要统一的 UI 读取接口，避免 Workspace 和 Conversation 各自组合相同状态。

Client 历史访问与 Host Agent（智能体）执行具有独立生命周期。历史打开可能失败；获取本地 Context 不一定需要读取历史。显式所有权必须保持导航、加载、错误处理与恢复行为，不添加无关 UI 策略。

## 决策

### 范围与所有权

Client Session 对象、Agent 作用域的 Client Context、引用、使用方来源元数据、UI 状态与显式 Provider 组合遵循下述所有权规则。Host Session 和 Agent 生命周期、SlotFactory、activity 列表视图、持久 Session 格式及两个 SDK 的 Host 协议保持独立。

| 所有者 | 职责 |
| --- | --- |
| Client Session Controller | 目录、活跃代、引用、来源计数、binding、历史窗口与既有 Session 控制状态 |
| `ui-session` | 显式 Session Provider 集成与统一 UI 状态来源 |
| 视图或操作 | 自己的引用、目标、来源标识与释放时机 |
| Workspace UI | 主区域目标与引用、导航、持久目标及创建流程 |
| UI 组合边界 | 将所有者提供的引用交给一个明确的 `SessionProvider` |
| Conversation 与 Sidebar 子树 | 只消费所在 Provider 的 Session，不读取主区域引用或全局选择 |
| Client Gateway | 处理 Host 事件时调用期的 Context 所有权 |

[Client 分层设计](../../implemented/architecture/2026-08-20-client-session-conversation-ownership.zh.md)定义数据、适配器、渲染器与展示层的单向依赖。引用来源统计不会使 Controller 依赖 UI 包。

本决策部分取代 [Web Client Session scope 与 provide channel 决策](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)中由 list 选择驱动的 scope 生命周期；后者保留显式 Provider 所有权下的 blank Session 与收养语义理由。

### 地址、binding 与引用

`SessionTarget` 是已知 `SessionId` 或持久的直接父子 `SubagentAddress`。它标识要获取的目标，不持有任何对象。Controller 解析显式地址时不要求预先加载 parent catalog，Host 则在打开历史时校验其 parent、child 与 mode。子会话发现与已知子会话地址均不等同于持有该子会话。导航使用同一种目标表示，不增加另一套导航地址。

`SessionBinding` 是共享的 Client 代，包含 `sessionId`、Session 接口、事件来源与作用域 Context。同一活跃代的多个引用共享这个 binding。同 ID 的新一代具有不同的 binding 和 Context。

`SessionReference` 持有某个确切代的一次使用。它公开只读 `sessionId` 和 `binding`、表示共享首次历史打开的 `ready` Promise，以及幂等 `release()` 与 `Symbol.dispose`。对应 `Session.open()` 尝试解析时，`ready` 解析为该确切 binding，包括以状态表示的 Remote failure 结果。引用释放或其代清理后，读取 `binding` 会失败。获取、释放或查看引用均不创建持久 Session，也不启动、停止或持有 Host Agent。

`SessionBinding` 是借用值，不构成持有。只有未释放的 `SessionReference` 计入来源与总引用数。同步代码可以在拥有者引用的生命周期内借用 binding；需要越过该生命周期的工作必须拥有自己的引用。

| API | 返回结果与调用方义务 |
| --- | --- |
| `sessions.retain(target, options)` | `SessionReference`；立即返回，调用方持有该引用直到释放 |
| `sessions.using<T>(target, options, operation)` | `Promise<T>`；依次等待 `reference.ready` 与 `operation(reference)`，释放自己的引用，并返回操作结果 |
| `sessions.retainInfo(id)` | 本地引用计数的稳定只读 observable，不获取引用、不创建作用域，也不执行历史 I/O |
| `sessions.scope(id)` / `sessions.binding(id)` | 借用已存在的活跃代或返回 `undefined`，不打开它，也不延长其生命周期 |
| `sessions.sessionOf(ctx)` | 返回匹配的活跃 Session 接口或 `undefined`；已结束的 Context 不能解析为同 ID 替代代 |
| `sessions.create(...)` / `sessions.fork(...)` | 既有 Host 操作，返回 Session 身份；持有与展示仍需显式执行 |

`SessionRetainOptions` 包含必填 `source: SessionReferenceSource` 与可选 `signal: AbortSignal`。两个获取方法均接受 `target: SessionTarget` 和这些 options。来源键由使用方定义，通过声明合并扩展；不提供运行时来源注册协议，也不默认使用主视图来源。来源是使用标签，不是另一种 Session 地址，也不授予操作权限。

### 获取、失败与释放

获取操作同步解析目标，创建或持有本地 Session、Context、fiber 和 binding，记录一份引用及其来源计数，启动该代共享的首次历史打开，然后返回引用。并发获取共享这次打开，但分别获得独立引用与就绪等待。共享的 `Session.open()` 尝试解析时，`reference.ready` 解析为仍然有效的确切 binding。

未知 Session id 的寻址在返回引用前失败；显式 subagent 地址由 Host 在打开期间校验。抛出的打开失败、调用方取消、引用释放或该代结束会拒绝该引用的 `ready`；取消一个等待方不会取消其他所有者共享的打开操作。以 `openState: 'error'` 表示的 Remote failure 跟随 `Session.open()` 语义并解析就绪，错误仍可通过 binding 渲染。调用方持有已返回的引用直到释放，而 `sessions.using` 会在就绪或操作失败时释放自己的引用。

`using reference = sessions.retain(target, options)` 在所在作用域退出时释放；需要等待首次历史尝试结算的代码等待 `reference.ready`。`sessions.using` 是面向回调调用方的辅助方法：它先等待该次结算，再调用操作并等待操作返回的普通值或 Promise，最后释放。返回值不能依赖辅助方法已经释放的引用仍可使用；需要更长生命周期的使用方自行获取引用。辅助方法传播被拒绝的就绪与操作失败，不提供兜底结果、重试或错误展示。模型选择的代际检查与错误状态更新保留在 ModelSelection。

`ready` Promise 成功表示首次 `Session.open()` 尝试已经结算；它不保证 `openState: 'open'`，也不保证连接永不中断。以状态表示的打开失败与之后的流失败继续通过既有 Session 状态公开。调用方保留对这些错误的既有处理与展示。

释放只移除该引用及其来源计数。最后释放在清理 Session 与 fiber 前撤回该代的准入和 ID 映射。后续 retain 可以立即创建新一代；旧代清理不能移除替代代。`release()` 同步发起本地清理，根清理等待尚未结束的异步释放工作。

所属 Client 根在关闭时使全部引用失效。它拒绝新的获取，撤回活跃映射，并汇合作用域清理与 Session 流释放。引用不能使已清理的 Client 根继续存活。仅移除目录记录不会清理仍被引用持有的代。

### 引用来源与 Session 列表记录

Controller 将来源计数与每个活跃代的引用共同管理。每个来源的计数等于该代尚未释放且带有该来源的引用数。同一 Session 可以有多个来源，同一来源可以持有多份引用。分配器不赋予任何来源特殊生命周期行为。

每条已有 Session 列表记录公开只读 `retainedBy`，由来源键映射到正数引用计数。未被持有的记录使用空对象；零计数键不存在。获取失败与释放更新该投影，包括删除最后一个来源键。Host 元数据刷新时，来源计数仍是本地事实，Host 响应不能覆盖它。

即使 Session 尚未进入 Host 目录或其目录元数据已被移除，计数仍由对应代持有。`byId` 包含 Host 摘要、子会话目录投影行，以及已保留且具有明确直接父子地址的 subagent 兜底行。获取引用时同步发布缺失的 subagent 行，使 Provider 发现不依赖父目录到达；标题投影和引用来源计数继续更新该行。普通被保留 Session 不合成兜底行。`ids` 仍表示 Host 列表成员关系与顺序。未列出 generation 的使用方直接读取其 binding 与 `retainInfo`。每条记录的 `retainedBy` 投影均使用活跃代的计数。引用对象与计数均不持久化，也不发送给 Host。

例如，`retainedBy = { mainView: 1, gateway: 2 }` 表示主视图与两个 Host 调用持有三份引用。释放主视图引用只移除 `mainView`；Gateway 调用继续持有该代。示例中的来源名是使用方键，不是 Controller 内封闭的枚举。

`current` 表示主视图占用：记录的 `mainView` 来源计数为正数时，就具有这个标记。这只是通用来源记录的一种用途，不是独立的 `sessions.current` 值或 Session 选择服务。其他使用方可以从自己的来源键派生标记。引用系统不要求全局唯一使用方，也不从多个来源中选择一个 Session。

主区域所有者管理自己的目标与引用切换。列表不根据恰好挂载了多少 Provider 推断选择。来源记录反映实际所有权，包括获取期间的短暂重叠；UI 导航仍负责自己的目标，不把选择权交给分配器。

窗口级使用方可以查看来源标记。Session 业务操作仍使用传入的作用域或显式引用，不得从目录中查找 `mainView` 来补齐缺失的操作目标。后台引用只能证明所有权，不能证明用户查看过 Session。

`SessionRetainInfo` 包含 `referenceCount` 与只读 `retainedBy` 记录。`sessions.retainInfo(id)` 独立于目录成员关系观察本地所有权，并在同 ID 换代时保持稳定。没有活跃代的身份具有零引用和空来源记录；读取该值不代表该身份在 Host 上存在。

`ui-session` 通过 `useSessionRetainInfo(sessionId, selector)` 读取明确身份，通过 `useSessionRetainInfo(selector)` 读取外围 Provider 绑定的 Session。未绑定作用域向后一种形式提供缺失值，不回退到主区域 Session。两种形式均由渲染器从相同的裸 retain-info 来源构造。使用方检查 `mainView` 来源计数以识别原 current-Session 角色，其他来源键也可同等查询。读取或订阅不会持有 Session。

### 统一的 UI Session 状态

`ui-session` 拥有不依赖 React 的 `sessionStatus` 来源，通过标准 `useSessionStatus` 钩子公开。快照按 Session 身份索引，为每个已知 Session 提供一条 UI 状态记录。它组合下列独立事实，不将它们压缩成互斥的单一阶段：

| 字段 | 取值 | 含义与所有者 |
| --- | --- | --- |
| `running` | `boolean` 或 `undefined` | 最新已知的 Session 运行事实；缺少基线不表示已确认 idle |
| `pendingInteraction` | `SessionPendingInteraction` 或 `undefined` | 领域拥有的有效请求；没有待处理请求时缺失 |
| `completionUnread` | `boolean` | 已观察到停止、但尚未确认的 UI 提醒 |

来源计数以 `SessionListState.byId[id].retainedBy` 为准；UI 状态读取它以执行确认策略，不维护另一套引用注册表。标题、Workspace 关联、历史、队列和投影数据保留在各自的既有所有者中。

待处理领域保留 `SessionPendingInteractionMap`、请求身份、优先级、发布清理函数与卸载委托。统一状态包含同一个有效请求对象，不复制请求，也不创建第二套待处理注册表。Workspace 状态指示器与 Conversation composer 选择读取 `useSessionStatus`，不再分别读取 `useSessionPendingInteraction` 和 `useCompletedSessionIds` 钩子。

完成跟踪订阅已有 `api-session/status` 事件，避免 running 到 idle 的变化在合批目录快照中丢失。Host 列表行（`ids`）建立初始与重连的 running 基线；目录合成行与 retained 行保留独立观察到的状态。pending 状态下的空目录不能证明 Session 已消失。更新规则如下：

- 初始 idle 基线不产生完成提醒。
- 观察到 running 时清除旧提醒，并记录运行基线。
- 从已知 running 变为 idle 时，仅在 Session 没有主视图持有的情况下设置 `completionUnread`。
- 获得主视图持有时清除提醒；无关来源的 retain 不清除提醒。
- 释放主视图持有不会为更早的一次停止补造提醒。
- 移除 Session 时清除其完成提醒与运行基线；待处理请求的清理仍属于请求领域。

提醒表示观察到的一次停止，不代表任务成功，也不代表某条排队消息完成。即使全局面板暂时隐藏 Conversation，主视图所有权仍保持基于选择的确认语义。本设计不提供 `ui-session/view-presence` 事件、已挂载 Provider 索引或 Provider 挂载时的隐式确认。

Session Controller 发布运行与引用来源事实，但不拥有完成提醒集合、`consumeCompletion` 方法或待处理交互展示。引用获取不执行完成提醒业务逻辑。

### 显式 Provider、并行 Conversation 与缓存身份

唯一的 `SessionProvider` 可以继承外层 binding，也可以用显式 `session={reference | undefined}` 覆盖本子树。它不获取或释放所有权。根 Provider 从 `mainView` 所有权标记解析主 binding，不维护另一份 current；并列或嵌套 Provider 只影响各自子树。显式缺失保持缺失，不回退到主区域。

Provider 注入选定 binding，但不为整个 body 设置 key。严格 `session` entry 在 binding Context 改变时重新挂载。空白 `session-maybe` entry 接受首个 binding 时不重新挂载；接受后，切换到另一个 binding Context 或回到缺失状态会创建新的组件 incarnation。

`uiWorkspace` 持有来源为 `mainView` 的主区域引用，`ui-session` 从该引用在 Session 记录中的所有权标记建立根 Provider。Provider 下的 Conversation、右 Sidebar、preset、命令、输入与模型组件只能读取 Provider 绑定的标准数据。它们不得读取主区域引用或全局选择，也不得按 Session ID 重新寻找一个可能属于其他 Provider 的 binding。

每个 Provider occurrence 以传入的 `SessionReference` 建立独立渲染作用域。两个引用可以指向不同 Session，也可以共享同一 `SessionBinding`；不同 binding 的业务与观看数据完全分离，同一 binding 的 Provider 共享 Session、Conversation、输入等 Session 级数据，但保留各自的组件局部状态。主区域与 Sidebar 可以同时挂载两个 Conversation，任一 Provider 的替换或卸载不改变另一棵子树的目标。

`ui-session` 为每个活跃 `SessionBinding` 复用稳定的业务 observable。Conversation assembly、input shell、command popup、input-trigger controller 与 model directory 等代际缓存以 binding 为弱键，不再以 Session ID 为键；需要枚举活跃值的缓存使用 `util-values` 的 `WeakMapWithValues<SessionBinding, Value>`，由弱键表和强值集合共同维护身份查询与值遍历。该容器不执行清理；订阅、控制器、URL 和其他资源仍通过 `binding.ctx.effect()` 确定性释放。Provider occurrence 的观看状态随该 Provider 的渲染作用域释放，最终 generation 清理由 binding Context 负责。

Descriptor 变化先组装替代来源再发布，不重建 Session 代。Provider 在读取 reference 时校验它仍有效；已经释放、来自其他 Controller 或不再对应活跃 binding 的 reference 不能创建作用域。

| 使用方 | 获取与释放 |
| --- | --- |
| 主 Conversation | `uiWorkspace` 获取导航目标；`ui-session` 从 `mainView` 标记建立根 Provider，Conversation 子树只消费 Provider 绑定 |
| 关联右 Sidebar | `RightbarRoot` 继承根 Provider，不读取主区域引用 |
| 独立 Session 视图 | 自己的所有者持有目标，并以自己的引用建立 Provider；与主区域同时运行 |
| Client 中的 Host 事件 handler | 持有本地 Context 引用直到 handler 与回复结算 |

Conversation 的引用属于其视图所有者，不属于 Chat、Trajectory 或某次点击。Chat、Trajectory、命令、输入、上传、图片读取与模型选择在 Provider 生命周期内借用同一 binding；它们不按行动重复获取引用。切换或关闭该 Conversation 可以结束仍在途的本地工作。Sidebar tab 的布局与资源所有权保持独立；只有承载 Conversation 的 Sidebar 视图所有者需要自己的 Session 引用。空布局与 guide 占位页不持有引用。

作用域业务对象从 Provider 捕获自己的 binding，不把旧 Context 或目录重新解释成同 ID 的新一代。ModelSelection 借用 Provider binding，并保留自己的选择代际与错误规则。编辑器脱离回调可能与作用域清理重叠；可选 trigger 和 popup 对已结束的 Context 返回空值，不解析其他 generation。

### 主区域导航与展示

`uiWorkspace.openSession`、`openWorkspace` 和 `startSession` 是导航入口。它们接受或解析明确目标，改变主视图，并按既有导航策略将主区域返回 Conversation。侧边栏 `forkSession` 创建并重命名子会话，不 retain 子会话，也不改变选择。`retain` 本身从不导航。引用所有权不引入 `registerNavigation` 接收者协议，也不引入第二个导航服务。

现有 `uiWorkspace` 实现直接持有来源为 `mainView` 的主区域引用与目标。导航方法直接更新该所有者，不调用 Conversation 注册的接收者。`ui-session` 根据来源标记把该引用对应的 binding 注入根 Provider；主 Conversation 和关联右栏只继承 Provider，既不依赖 `uiWorkspace`，也看不到主引用。独立 Sidebar Conversation 以自己的 reference 建立嵌套 Provider，并覆盖本子树的 binding。主引用不是全局标准 prop、子树 Hook 或按 ID 查询的默认值。

主视图在 `dsh.sessions.current` 下私下持久化目标身份与子会话地址，不保存引用。启动恢复、初始 Workspace 选择与归档主目标后的清空仍属于 UI。归档或移除目录元数据不撤销其他使用方持有的独立引用。

| UI 行为 | 最终规则 |
| --- | --- |
| Session 列表高亮与空白记录处理 | 从 `retainedBy.mainView` 派生主区域占用，不按已挂载 Session Provider 的数量判断 |
| New Session 的 Workspace | 优先使用显式 Workspace，其次按既有查找规则使用主 Session 的 Workspace，最后使用既有最近 Workspace 策略 |
| Onboarding | 判断主区域 Session 是否缺失或为空白，不判断所有历史 Session |
| 浏览器文档标题 | Conversation 显示 Session 标题与产品标题；全局面板显示产品标题 |
| Chat/Trajectory 恢复 | 为显式选中的主目标恢复视图；独立绑定的视图保留自己的状态 |
| Cordis inventory 面板 | 使用不区分 current/other 的单一列表；runner 不提供主区域选择的公开 getter |

DOM 焦点移动或全局面板隐藏仍被持有的视图时，来源元数据不变。[全局主面板设计](../../implemented/architecture/2026-09-08-global-main-panels.zh.md)拥有面板选择与布局；Session 引用所有权不替代它。

Conversation 保留 `hero`、`settling`、`active` 组合与既有历史加载和 `openError` 处理。获取引用不增加外层 loading/error 阶段展示、额外隐藏 composer 的条件、Retry 按钮或替换 Sidebar 内容的恢复面板。已有错误处理方继续处理自己的错误；没有错误展示的调用点不增加展示。Promise 拒绝与正确释放引用不意味着额外增加 UI 处理方。

Workspace 连接保持既有导航检查与面板切换失效规则。侧边栏 fork 不替代尚未完成的导航。直接打开 Session 不增加全局导航取消策略。Agent Team 刷新保留发起时选择仍然有效的条件，不在刷新前启动全局导航 token。引用获取不扩大取消范围，不影响无关导航或正在执行的操作；本地取消不回滚 Host 效果。

### 预设与创建流程

预设目录与部署默认值可以共享。已绑定 Session 的预设通过 Provider 的 binding 读取或修改；预设控制器按 `SessionBinding` 缓存，不由根级 current-Session 跟随器管理。Hero 的 preset seat 使用 `session-maybe` Provider：没有 Session 时显示创建流程选择，绑定空白 Session 后操作该确切 Session。标题标签读取同一 Provider 绑定 Session 的投影。

Session 创建前选择的 preset 保留在主 Conversation 的 `session-maybe` preset surface 中。Workspace 创建或复用空白 Session 并建立主 Provider 后，该 surface 将选择应用到 Provider 绑定的 Session。设置页修改默认 preset 时，preset 服务从 Provider 已建立的 binding 缓存中选择带 `mainView` 所有权标记的空白 Session，并更新该 Session。非空白主 Session、Sidebar 的独立 Provider 与其他后台引用均不受该设置动作影响；preset 子树不读取主引用，也不通过全局 current follower 寻找目标。

### Host 事件 Context 所有权与 Typert

经校验的 Host waterfall（瀑布式事件）身份可以先于目录发现到达。Client Context 解析器必须保持同步。它带上 Gateway 的来源获取本地代引用，返回 `TypertOwnedValue<Context>`，不打开历史，也不刷新子目录。需要历史的 handler 另行获取公开引用并等待其 `ready` Promise，或使用 `sessions.using`。

Gateway 持有本地引用，直到 handler 使用与回复结算均结束。Context 获取失败保留既有的记录错误并委托语义，handler 失败产生拒绝回复。取消通过已有 signal 到达 handler，并抑制晚回复，但不会在 Context 仍被使用时提前释放。插件关闭汇合当前连接代的在途 handler；Connection 只在该来源结算后启动替代代。

`TypertOwnedValue` 跨通用 Gateway 传递值及其清理操作。它没有额外引用计数，也不要求 Gateway 理解 Session 专用所有权。独立 Client bundle 共享 owned-value 标记。Client 发请求的 `identity(ctx)` 保持同步；Host Context 解析与 Host 生命周期不变。

## 考虑过的替代方案

**以目录成员关系作为所有权。** 发现数据无法证明视图或操作仍在使用，而且部分 Context 身份先于目录成员关系到达。

**隐式主 Session 加显式替代路径。** 两套目标解析规则会使可复用组件依赖其渲染位置。显式 Provider 提供目标，通用来源记录服务于窗口级观察。

**Provider 子树继续读取 `mainSession`。** 同一组件会同时拥有 Provider 与窗口级目标，Sidebar 的独立 Conversation 也会被主区域变化重定向。主引用只参与 Provider 装配，子树只读取 Provider。

**以 Session ID 为代际缓存键。** 最终释放允许同 ID 新代在旧清理结束前出现，ID 键会复用旧对象或让旧清理删除新对象。业务缓存使用弱引用的 binding 身份，资源清理由 binding Context 负责。

**只在历史打开后解析的异步 `retain`。** 它会把 Provider 安装与主视图导航推迟到历史到达之后，导致既有加载状态无法立即渲染。同步引用把所有权与显式的 `ready` 结果分开。

**在同步 Context 解析中执行历史 I/O。** Host 事件派发需要作用域生命周期，不一定需要历史窗口；耦合两者会在目录发现之前延迟或阻止 handler。

**专用 current 标志。** 一种使用方专用标志无法描述 Sidebar 与后台所有权。主视图标记可以从通用的按来源计数中派生。

**Session Controller 中的完成状态，或独立的待处理与完成提醒钩子。** 完成确认属于 UI 策略。统一 UI 状态来源组合独立事实，同时保留领域拥有的待处理对象与 Controller 拥有的运行事实。

**以 Provider 呈现决定确认或释放。** 挂载既不等于所有者生命周期，也不等于基于选择的确认。它无法决定哪些后台或暂时隐藏的使用仍应存活，或应当算作已查看。

**Provider 中的裸 ID 或全局 binding revision。** ID 不表达代际所有权，全局刷新会使无关 Session 使用方失效。

**每个行动各自获取引用。** Provider 已经定义 Conversation 的使用生命周期；为每次点击重复持有会把视图所有权拆成大量细粒度来源。只有明确需要越过 Provider 生命周期的工作才另行持有引用。

**导航注册、新的取消策略与获取专用恢复 UI。** 引用所有权要求显式目标、释放与失败传播，不要求额外导航或恢复行为。

**Client 引用持有 Host Agent。** 历史访问与 Host 执行是独立使用需求，长时间打开的 Client 视图不能定义 Host 业务操作生命周期。

## 验证

- 获取测试覆盖共享首次打开、普通与意外打开失败、独立等待方取消、确切代替换，以及根清理达到完全停稳。
- 来源测试覆盖多个来源、同来源多份引用、获取失败回滚、幂等释放、目录刷新或移除，以及旧代的晚释放不改变替代代。
- Retain-info 钩子测试覆盖明确身份、Provider 绑定默认值、未绑定与嵌套作用域、跨代来源更新，以及读取不创建引用或请求历史。
- 作用域与 Gateway 测试覆盖目录发现前不执行历史 I/O 的同步 Context 获取、获取失败的记录与委托、handler 的拒绝回复、取消与结算期间的所有权，以及跨 bundle 共享的 owned-value 标记。
- UI 状态测试覆盖待处理优先级与清理、会被快照合批丢失的事件变化、初始与重连基线、主来源确认、无关来源持有，以及不存在 Provider 呈现事件。
- 视图验证覆盖两个不同 Session 和同一 Session 多次使用的并行显式 Provider、互不重定向的 Conversation、独立 Slot store、作用域 preset、descriptor 更新，以及没有新恢复控件的 Sidebar 生命周期。
- 实际组合浏览器场景保持主区域高亮、空白记录、onboarding、Workspace 默认值、标题与约定的导航或错误行为。只有 Client 所有权改变时，已有模型轮次录制仍作为行为输入。
- 公开 `retain`、`using`、Provider、生成 API 目录、包约定与类型检查对 options 和所有权保持一致。Provider 子树不读取主区域引用，独立所有者各自释放自己的引用。

## 后果

使用方必须把引用保留到真实结束点；在活跃 Client 根内，未释放引用仍会泄漏。最后释放后再次 retain 会创建新一代，并可能重新打开历史。来源计数描述所有权，不描述可见性、任务成功或操作权限；以主标记作为业务兜底会重新引入隐式 current-Session 耦合。

最后一份 reference 释放后，未持久化的 binding 自有状态会被丢弃，包括已加载的历史页、Chat 滚动锚点、预览换行、Files 展开状态、composer 附件和 undo 历史。只有持久化的 Session-keyed Store 值或由另一份 reference 保活的 generation 能跨视图切换保留；runtime 不会清除这些持久值。

每次公开 `retain` 都会启动该 generation 共享的首次历史打开，包括普通 Session 重命名所用的临时引用。Fork 标题设置直接发送 rename 并应用返回的投影，不获取 Client 引用，也不读取历史。因此，仅修改元数据的 fork 操作不会创建列表临时行或切换主视图。

目录、UI 状态与视图目标由不同所有者管理，可以独立发布。使用方不能仅从通知顺序推断生命周期变化。主视图仍是普通引用所有者，其导航与展示规则留在 UI，不进入引用分配器。
