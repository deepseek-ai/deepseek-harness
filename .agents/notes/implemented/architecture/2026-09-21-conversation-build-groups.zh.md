# Agent Note: Definition 拥有分组业务，框架统一调度 Node／Group 输出

Status: implemented

[English](2026-09-21-conversation-build-groups.md) | 中文

## Problem

Chat 需要把连续过程内容收进可展开的组，同时保留独立回复、用户输入和轮次控件。Compact、Detailed、Expanded 必须共用分组结果；切换模式不能通过删除组容器、移动成员父级或更换 key 重建 React 实例。

Chat Builder 汇总整个目标的节点及索引。在其中固定创建 Chat 过程投影器，即使把部分缓存移到通用层，仍然让 Builder 拥有业务分段。业务 Definition 才是这些规则的注册点。

过程组与 Step 正交：同一个 Assistant Node 可以把推理放在组内、回复放在组外，回复后的工具进入后面的组。Step 编号范围无法描述这种成员归属。现有事件 Definition 逐个解释事件，分组则需要这些 Definition 已经解释完成的节点。

宽松的基准预算不能证明分组更新具有局部性。按键通知、组件身份、浏览器布局与常驻内存是不同的性质，通过其中一项检查不能证明其他性质。

## Decision

分组基础机制提供独立的节点输入 `ConversationGroupDefinition`、注册表及 Session 内上下文、Builder 通用输入与发布、按键 Group 存储及两种 React 分支。Chat 在[业务规则参考](../../../../packages/client/ui-chat/src/client/conversation-nodes/README.zh.md)中拥有其已注册的分段与展示规则。[子系统参考](../../../../docs/subsystems/conversation.zh.md#group-definitions)与[源码类型](../../../../packages/client/ui-conversation/src/client/contract/groups.ts)拥有当前 API 细节。

### 职责

| 要求 | 含义 |
|---|---|
| 分组业务属于已注册 Definition | 成员、分段、回复、steering、重试、摘要和缓存失效放在一起。 |
| Builder 与 assembler 做统一工作 | 提供输入、调度 Definition、校验引用、复用身份并发布，不创建具体分组类。 |
| PR #4565 提供产品参考 | Chat 业务规则参考拥有当前行为及已确认的调整。 |
| React 根循环只有两种 kind | 根顺序包含 NodeReference 和 GroupReference，不引入另一套布局对象模型。 |
| 所有模式共用分组 | 模式不进入 Definition 输入、key 或父级选择。 |
| 不采用 buildLayout | ConversationViewDefinition 保留现有职责。 |
| 业务属于目标包 | Chat 拥有过程分组、摘要、通知和页脚行为，通用组装不解释这些业务。 |

### 与已有记录的关系

| 记录 | 关系 |
|---|---|
| [业务节点组装](2026-08-09-client-conversation-node-assembly.zh.md) | 保留事件匹配、Context、Location、每个 Context 一个业务 Node 及目标 Builder，分组增加另一种输入类别。 |
| [Chat 滚动与页脚](../bug-fix/2026-09-22-chat-scroll-follow-and-footer-geometry.zh.md) | 负责裁剪与独立的嵌套跟随，不改变 Group Definition 成员关系。 |

分组保留独立的节点组装决策。跨 View 导航与 `toolCallFocus` 仍是独立职责，Group 引用不携带 View 句柄或资源导航策略。

## Definition 输入、状态与注册

`ConversationNodeDefinition` 保留 `match/start/update/publication/buildLocationData/buildViewNode`，`ConversationViewDefinition` 保留 `target/create/isActive/toolCallFocus`。分组业务通过 `ctx.uiConversation.groups.register(processGroupDefinition)` 注册，不加在上述已有 Definition 的回调中。

- 每个目标只有一个 Group Definition，拥有完整分组语义。重复目标注册报错，不选择胜者，也不叠加策略。
- 注册要求已有 View 目标，但不构造 Builder。首次激活取得 Builder 后检查 `groupInput()`，缺少输入方法时报错。未分组目标不要求该方法，也不分配 Group 状态。
- 每个 Session 为已注册 Definition 拥有一个派生上下文。`create()` 初始化 State，不是 `turn/start` 事件，也不是事件 Definition 的唯一 start Match。Definition 对象不保存跨 Session 的可变状态。
- `update(context, input)` 返回框架采纳的 State。`buildGroups(context)` 物化待输出结果，不重新解释事件，不因重复读取增加计数。替换输入要求输出完整根序列和组替换，避免已移除节点留下悬挂引用；apply 的 `null` 保留结果。
- `replace` 提供目标顺序、时间线及同步的 `readNode`、`readTurn`、`readPosition` 读取器；`apply` 还提供投影后的节点前后值、`changedTurns` 和 `changedTurnOrders`。读取器仅在当前同步调用中有效，不保留到 State。
- 节点数据仍在目标 Node Store。仅正文更新保留顺序数组；旧值在 Builder 安装投影结果前记录，也覆盖目标投影额外改变的节点。
- `ConversationLocationIndex` 从边界事件和 Location 数据写入累计变化轮次。assembler 将同一批变化交给全部被更新目标，覆盖没有节点 upsert 的 Turn 结束。直接调用未分组 Builder 的调用方可省略该字段。
- 目标位置索引通过 `changedTurnOrders` 提供可见键、所属 Turn 或紧邻关系的变化，包含移动 Node 的新旧所属轮次，以及受相邻轮次外 Node 影响的轮次。`readTurn` 返回某个 Turn 的可见键，`readPosition` 返回包含所属 Turn 和前后紧邻键的 `GroupNodePosition`。仅按 Turn 读取会遗漏轮次外 Node 造成的分隔，业务分段可以通过相邻事实保留这些分隔。索引提供位置，不决定分组。
- 通用 GroupDataMap 在注册、存储及读取之间关联目标和 Data。未声明的目标没有组载荷类型，业务消费方不通过 unknown 断言恢复摘要类型。

## Node／Group 引用与更新

`NodeKey` 表示既有 Context Node，`GroupKey` 在 Session、目标及 Definition 内标识组。`NodeReference` 与 `GroupReference` 在 `RenderEntry` 中地位相同。`GroupSnapshot<Data>` 单独保存组的不可变数据与有序 NodeReference 成员，不混入根顺序。创建 Group 不增加 Session 事件或执行生命周期。

`groupPart` 是渲染器拥有的节点部分，例如 reasoning 或 response，省略表示整个 Node。部分引用也可以独立位于根层。部分内容的完备性和归属由业务渲染器负责，不由框架判断。组数据描述状态、计数或摘要，不复制 Node 正文、工具结果或可变业务 State。组不携带 renderer 字段、CSS、坐标、React 元素、导航或嵌套组。

| 更新 | 含义 |
|---|---|
| apply 输入省略 `entries` | 保留根顺序；替换输入必须提供完整序列。 |
| 提供 `entries`，包括 `[]` | 替换完整根序列，空数组清空根序列。 |
| `groups: { kind: 'replace', snapshots }` | 替换完整组记录，移除未包含的旧组。 |
| `groups: { kind: 'apply', upserts, removes }` | upsert 完整快照，只按具名 GroupKey 删除组。 |
| 仅数据变化 | upsert 新 data，复用 members，省略 entries。 |
| 仅成员变化 | upsert 该组完整的新成员数组，不替换全部组。 |
| 仅根顺序变化 | 提供 entries，apply 的 upserts/removes 为空。 |
| 解散一个组 | 原子地用成员替换根引用并删除 GroupKey，保留原 Node。 |

`entries` 与 `groups` 属于同一安装批次，不是独立发布通道。删除成员引用不删除 Node。upsert 需要快照内容，删除只需要身份。真实成员归属变化可以让 React 重挂载成员，但模式切换不能解散组。

存储在修改前校验最终提交结果：每个根 Group 恰有一份记录和一个根位置；Node 引用存在；重复 upsert、重复删除及同时 upsert/删除均报错。全部根和成员中，每个 `(NodeKey, groupPart)` 最多出现一次。整 Node 不能与自身任一部分共存，不同部分可以占据不同位置。允许引用在一次原子更新中移动位置。

GroupStore 按 GroupKey 索引记录和来源，不反复查找数组。等价根数组、成员数组及未变化组快照保留身份。仅数据 upsert 只检查提交的快照，不扫描根、未变化成员或 Node。完整替换重新校验引用，仍按 key 对齐结果。Definition 缓存拥有业务计算，GroupStore 拥有已安装结果及通知。

## 组装时序与生命周期

1. BoundConversation 从现有 feed 接收 append、prepend、replace 或 Assistant settlement。
2. assembler 运行既有 Node Definition 匹配、状态更新及必要的 Context 重放。
3. 既有 immediate/animation-frame/none 节奏调度发布，分组不增加计时器或事件订阅。
4. flush 依次物化 Step、Turn Location 数据及目标 Node。
5. Builder.replace/apply 安装投影后 Node、目标顺序及索引，记录位置变化，保留包含索引读取器的 GroupInput，不通知独立来源。
6. assembler 取得目标已注册的 Group Definition 上下文，以 builder.groupInput() 调用 update，采纳返回 State。
7. 调用 buildGroups，校验并安装结果，安装目标快照。
8. 全部受影响目标安装完成后，调用 Builder.publish，发布 Group 来源和 Location 数据。
9. BoundConversation 发布既有根 Conversation 来源。

首次激活的 replaceView 与普通 flush 使用同一目标更新函数。未激活目标不创建 Builder 或 Group 上下文。注册重建一并采纳 View 和 Group Definition，丢弃被替换或删除的 Group 上下文并清空旧观察结果。未替换的 Definition 复用按键存储。React 接收 Node Store 身份，让存储替换时重新绑定按键钩子，不替换 key 或 DOM 实例。

已注册的 View Definition 被移除后，分组计算暂停并清空派生结果，Group Definition 注册仍保留。View 恢复时沿现有替换流程，从当前已加载时间线重建。首次注册 Group 时仍拒绝缺失的 View 目标；切换页签不会注销 View。

分组不重放原始事件。Node Definition 先处理重放，分组消费其最终目标替换或变化。prepend 可以修正边界并真实移动成员。Definition 处理新旧 Location 和变化轮次，不把分页或每个正文分片都当作完整历史重新分组。

## 具体实现落点

| 层／文件 | 职责 |
|---|---|
| [groups.ts](../../../../packages/client/ui-conversation/src/client/contract/groups.ts) | Group Definition、输入、引用、更新、类型数据映射及读取器。 |
| [conversation.ts](../../../../packages/client/ui-conversation/src/client/contract/conversation.ts) | Builder 可选 groupInput/publish 和快照存储 grouped 读取，已有 Node/View Definition 不变。 |
| [group-registry.ts](../../../../packages/client/ui-conversation/src/client/conversation/group-registry.ts) | 复用注册表基类，目标唯一性、类型化注册及 effect/disposer 生命周期。 |
| [assembly.ts](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) | UiConversation.groups 与现有 binding 重建通知。 |
| [assembler.ts](../../../../packages/client/ui-conversation/src/client/conversation/assembler.ts) | 首次激活和 flush 共用调度，上下文归属、安装及发布。 |
| [location-index.ts](../../../../packages/client/ui-conversation/src/client/conversation/location-index.ts) | 累积变化轮次，覆盖仅生命周期和 Location 数据变化。 |
| [group-store.ts](../../../../packages/client/ui-conversation/src/client/conversation/group-store.ts) | 原子引用校验、按键来源、数组复用及局部发布。 |
| [chat-snapshot-builder.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) | 记录投影后节点增量、目标位置及变化轮次顺序，提供索引读取器并推迟来源通知，不持有过程分组类。 |
| [ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) | 读取可选根引用并切换 node/group，无分组时使用既有 Node 顺序。 |
| [ChatGroupSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx) | 稳定组父级、组内订阅及嵌套 Node 容器。 |
| [ChatNodeSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) | 既有 Node 来源及渲染器、groupPart 传递、独立部分锚点及 Store 替换时重绑定。 |
| [slots.ts](../../../../packages/client/ui-chat/src/client/contract/slots.ts) 与 [apply.ts](../../../../packages/client/ui-chat/src/client/apply.ts) | 使用现有按键钩子注入 Group 来源，不改 Slot 引擎。 |

## React 读取与展示

根层通过既有 useConversation 来源选择 `views.grouped('chat')?.entries`。按键 Group 钩子沿用现有注入，Group 容器选择 members。成员使用既有按键 Node 来源。根列表移除组件前，已删除 Group 来源可能先返回 undefined，因此选择器允许不存在，并保持钩子顺序稳定。

React key 由引用 kind、NodeKey/groupPart 或 GroupKey 的无歧义元组派生，不另设 RenderKey 类型或 renderer 分发字段。Compact、Detailed、Expanded 保留同一组容器及成员父级，展示变化不重新运行 Group Definition，也不选择不同的根分支。

稳定 Group 父级使用可测量的 `div`，正文拥有组内限高滚动，内容盒子报告尺寸增长。CSS 继承仍然可用，业务样式适配子级／兄弟选择器。CSS 变量和几何信息都不进入 Definition。阅读位置采样测量成员 Node，保留部分专属锚点；既有轮次导航将原 NodeKey 解析到它的第一个可见部分。

展示通道将每个存储模式映射为稳定策略对象。Seat 和 renderer 选择自己使用的字段，不通过所有 renderer 透传模式 prop。模式变化不注册 Definition，也不重放 Context。整轮折叠资格使用本轮已加载的生命周期事实，不依赖整个 Session 的分页完成状态；半截历史的折叠规则由业务参考定义。组开合保留在组件本地状态中，显式收起整轮通过注入 Hook 重置参与折叠的内部开合，不更换 key。

## Alternatives considered

**Builder 持有 buildGroups 或过程投影器。** 不采用，目标汇总器仍然拥有业务规则，把缓存移到通用层不能改变归属。

**在原事件 Definition 加 buildGroups，不补输入。** 不采用，回调名称不能提供跨节点输入、生命周期变化或重建语义。

**Group Definition 重放原始事件。** 不采用，它重复 Assistant、Tool、Message 解释，并可能偏离 Builder 最终可见顺序。

**ConversationViewDefinition.buildLayout。** 不采用，它把目标工厂扩展成业务布局回调，没有独立注册业务 Definition。

**每个 Group 一个事件 Context。** 不采用，边界取决于前方可见内容，不由一个携带组起点身份的事件决定。目标内派生上下文也能处理 Turn 外独立节点。

**依赖图、ViewItem 类、工厂、嵌套组或策略叠加。** 本阶段不采用，一个目标输入和一份非嵌套分组输出覆盖当前诉求。

**独立的数据更新操作。** 不采用，复用 members 的不可变快照 upsert 已经能更新摘要，不替换其他组。

**Group Definition 同时增删 Node 和 Group 实体。** 不采用，Node 数据已有所有者，引用对称不需要第二个 Node 所有者。

**Expanded 移除组容器。** 不采用，即使 key 不变，父级改变仍会重挂载成员。

**让首成员或每 Step 的 Context 承载组头。** 首成员组头把组 UI 耦合到任意业务行。每 Step 的身份无法区分同一步内的多个组，共享整轮聚合数据还会刷新无关组头，或让后续 Step 的读取过期。

**一个事件 Context 输出多个 Node，或派生子 Context。** 多数事件 Context 只拥有一个 Node，数组增加间接层却不能解决跨 Node 分组。父级派生 Context 需要转发、重放及移除生命周期，只有派生实体需要独立于分组的这些生命周期时，才值得另作框架决策。

**常驻全部 Markdown，或靠重挂载重置 renderer。** 保留轻量 Seat 不意味着需要常驻所有完整 Markdown 正文。完整正文仍由开合状态控制，显式重置避免销毁无关 renderer 状态。一次性引入 #4565 的全部改动还会混合独立视觉变化与分组成本，难以判断导致回退的具体行为。

## Verification

- [Group 存储测试](../../../../packages/client/ui-conversation/tests/conversation-group-store.client.spec.ts)覆盖原子引用校验、根与成员身份复用、局部发布，以及删除组但保留原 Node。
- [分组调度测试](../../../../packages/client/ui-conversation/tests/conversation-groups.client.spec.ts)覆盖首次激活、仅生命周期输入、注册替换、View 移除与恢复，以及完整替换输出。[Assembler 测试](../../../../packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts)覆盖变化轮次报告和 Location 数据来源。
- [Node 来源测试](../../../../packages/client/ui-chat/tests/chat-node-source.client.spec.ts)覆盖投影后的分组输入、索引读取器和空变化批次。
- [Chat 渲染测试](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx)保留模式切换时的组件状态，重绑定替换后的 Node 存储，传递独立部分，并省略未引用 Node。[视口测试](../../../../packages/client/ui-chat/tests/chat-viewport.client.spec.ts)覆盖组内阅读锚点、历史前插及部分感知的轮次导航。

业务行为通过按键更新回归与已录制的 Web 回放验证。

| 证据 | 必须观察到的结果 |
|---|---|
| 按键通知与 React 更新 | 正文增长影响所属 Node 和相关 Group；未变化历史行及其他 Turn 没有额外通知。模式变化保留 key 与成员父级。 |
| 已录制的 Web 回放 | 当前可访问标题、组开合、普通 Context 隐藏、触发通知及页脚位置与提交的预期输出一致。 |

[已录制的 Web 场景](../../../../apps/web/tests/steering.e2e.ts)通过正式 Web profile 覆盖在线 steering、重连接续与分组展示。这些行为检查不构成量化延迟或内存改善的证明。

## Consequences

- 这是明确的框架扩展，包含新输入协议、注册表、上下文、发布阶段及读取器，不只是增加一个回调。
- 目标内 State 不会自动让业务更新局部化，Definition 可以根据节点变化和轮次顺序变化选择受影响的组及范围。结构变化仍按可见顺序重建目标位置索引，仅正文更新不重建该索引。结构性分组输出仍替换完整根引用数组。
- Node 顺序及可见性只有 Builder 一个所有者，分组不独立排序原始事件，也不在通用层再次推断成员。
- 稳定挂载不消除布局、绘制或保留内存的成本，不宣称实测延迟或最优性能。
- 真实组拆并、首成员变化及分页修正可以改变身份，模式切换保证不禁止这些正常变化。
- 隐藏部分的揭示、选择复制、中断提示、组开合与外层 Turn 联动属于 Chat 业务适配，仅凭通用引用测试不能确认这些行为。
- 整轮状态与用时替代旧工具／消息计数标题，因此状态、可访问名称和空过程轮次需要明确的展示覆盖。隐藏普通 Context 时保留非人工唤醒通知及原始 Session／Trajectory 查看能力；页脚定位依赖真实 Turn 结束，不依赖分组成员。
