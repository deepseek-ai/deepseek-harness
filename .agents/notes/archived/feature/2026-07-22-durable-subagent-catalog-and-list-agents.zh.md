# Agent Note: 持久化 subagent 目录与 list_agents

Status: implemented
Archived: 2026-09-04

[English](2026-07-22-durable-subagent-catalog-and-list-agents.md) | 中文

## 问题

可继续的后台 subagent 会公开稳定的 child id，并将重建数据持久化在该 child 的会话中，因此 `send_message` 无需任何列表查询操作即可恢复已知 child。发现功能有两类需求不同的消费方：UI 可以同时展示一次性工作和可继续对话，而模型只应收到适合使用 `send_message` 的 child。[可继续 subagent](../../implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)负责持久化 Session 与 Activation 设计；本记录负责共享的持久化清单及面向模型的投影。

枚举必须交叉核对不可变的会话谱系、描述符有效性与实时优先的会话语料，而不能仅为展示就加载或恢复 Agent。追踪谱系可以提供候选项，却无法区分普通会话 fork 与 subagent，因此 child 日志需要持久化分类。约定还必须定义生命周期模式、缺失或损坏的记录、删除、不受支持的版本，以及反复加载大量 child 日志会如何影响服务与工具消费方。

## 决策

**列表读路径已被取代。**[subagent 列表经投影单元读取身份](../architecture/2026-08-06-subagent-list-identity-projection.zh.md)取代了本记录的枚举与逐 child 读取设计:`listChildren` 现在直接合并存活会话存储与可选的会话持久化,并从注册的 `subagent` projection unit 读取每个 child 的 mode/label——不依赖会话查询,也不在列表时扫描描述符;当前的列表语义(含 diagnostic 映射)以该记录为准。本记录仍是描述符持久化、以 mode 判别的描述符作为持久身份、直接 parent 鉴权与面向模型的 `list_agents` 投影的权威;下文基于追踪的读取机制是决策背景,不再是当前行为。

parent 到 child 的枚举是一项带消费方专用投影的服务功能。`SubagentRuntime.listChildren(parentSessionId: SessionId)`（[subagent/src/index.ts](../../../../packages/subagent/subagent/src/index.ts)）执行以下操作：

- 使用 `ctx.sessionQuery.traceSession(parentSessionId)` 获取 parent 的直接且实时优先的 child 会话；
- 读取并校验每个候选会话的 `subagent/descriptor` 事件，但不激活 child；
- 默默排除不含描述符的候选；如果候选变得不可用，或其描述符损坏或版本不受支持，则排除该候选并产生对应 child 的 diagnostic；
- 公开每个由本地会话支撑、拥有受支持且有效描述符的 subagent；该描述符必须带有持久化的创建 `label` 和 `mode`，而其提供方当前是否已注册不影响公开；
- 将语料活动状态单独报告为 `running` 或 `inactive`，但不暗示已完成或可恢复；
- 按 `createdAt` 升序、再按 child id 升序稳定返回所有结果 child。

每次普通的本地启动都会收到带可选、由调用方拥有之显示标签的 `one-shot` 描述符，而继续执行管理器会持久化带标签、包含附加重建字段的 `continuable` 描述符。面向模型的委派工具已经拥有简短 `description`，会将其用于一次性显示；workflow 等底层调用方无需凭空构造展示元数据。面向模型的 `list_agents` 适配器会将服务结果过滤为可继续 child，并通过在线 Agent 注册表细化状态（`running`／`idle`，以及对应仅存于存储的 [`ready`](../bug-fix/2026-08-06-list-agents-residency-vocabulary.zh.md)）；UI 可以消费两种模式，并为无标签的一次性历史选择基于 id 的回退展示。描述符持久化、按 id 查找、直接 parent 鉴权和不依赖提供方的冷恢复仍归已实现的 Activation 约定负责。列表查询消费这些事实，但不能削弱它们，也不能另行发明第二种描述符表示。

### 枚举决策

第一版消费 `ctx.sessionQuery.traceSession(parentSessionId)`，并且只考虑追踪结果的第一层后代。目标可以存活，也可以只存在于持久化存储中；追踪逻辑语料不会加载或恢复 Agent。会话查询已经使用实时优先规则合并 `ctx.sessions` 与 `ctx.sessionPersistence`，保持不可变 header 一致性，根据 `SessionHeader.parentSession` 推导直接 child 谱系，并按 `createdAt` 升序、child id 升序排列 sibling。`listChildren()` 不会重复实现这套语料逻辑，也不会检查继续执行管理器的进程内 Activation map。

语料构建先于逐 child 描述符检查。构建初始追踪时如果发生持久化列表查询失败、所观测语料中任意位置的存活／持久化 header 冲突或目标谱系无效，整个 `list_agents` 调用都会失败，因为此时不存在可信的候选集。只有初始追踪成功后的失败才会被隔离到单个候选；因此，这项逐 child 约定中的“损坏 child”是指已加载的事件 surface 或描述符数据损坏，而不是语料级 header 冲突。

会话谱系涵盖的范围比 subagent 身份更广：普通 `ctx.sessions.fork()` 也会创建直接 child。会话 header 不新增 `kind` 判别字段；每个候选必须改为在自身后缀中恰好包含一个有效的 `subagent/descriptor` 事件。`SubagentRuntime.start()` 会在普通提供方分发前解析 `{ mode: 'one-shot', provider, label? }`，而继续执行管理器会在初始创建 child 时为 `{ mode: 'continuable', ...composition }` 建立快照并将其作为 seed。本地进程内的一次性驱动只在初始创建期间追加已解析的描述符，从持久化存储冷恢复时不会追加其他描述符；第二个事件属于损坏，而不是另一次 Activation 的证据。Agent 创建是一次性运行的发布边界：拒绝表示没有发布 child，而发布后的提示词、轮次、取消与基础设施结果会通过返回的 run 结算，且不会隐藏其 id。描述符事件是已追踪 child 属于由会话支撑的 subagent 的唯一证据。缺少该事件的候选属于普通 fork、没有本地会话记录的远端 child 或其他非 subagent 会话，系统会将其排除且不产生 diagnostic。

已发布的逻辑记录同时也是活动状态来源：`SessionRecord.live` 表示 `running`，而 `live: false, persisted: true` 表示 `inactive`。活动状态直接来自追踪结果，不会导致额外加载 child 日志。`inactive` 既不表示执行成功，也不表示可恢复：它可能表示已结算的一次性历史，也可能表示 `send_message` 可以为其物化另一次 Activation 的可继续 child。反过来，`running` 只表示会话存活：位于继续执行管理器对应 Activation 之外的存活可继续 Agent 仍会显示为 `running`，但 `send_message` 会将其作为所有权冲突拒绝。child 会话发布前不可见，也不会添加进程内 Activation 条目作为第二个候选来源或活动状态来源。列表查询是一份快照，可能与发布、dispose 或后续消息发生竞态；`send_message` 仍是消息送达时的权威操作。

subagent 服务将 `sessionQuery` 保持为可选依赖，因此没有该服务时仍可执行 start 和 follow-up。其公开的 `listChildren(parentSessionId: SessionId)` 方法只在被调用时才会解析这个可选服务，并动态加载可选的会话查询运行时；因此，普通 subagent 导入、start 和 follow-up 都不会触发该包求值。列表查询直接由 `SubagentRuntime` 负责：它解释查询返回的谱系、事件和存活状态，无需解析基于 Activation 的继续执行管理器，也不会查询 Agent 注册信息、Activation 或提供方；因此，仅包含会话、`subagents` 和 `sessionQuery` 的部署即使缺少 `agents` 也能执行列表查询。如果查询服务缺失，该方法会在加载运行时或执行查询工作前抛出 `SubagentError`，并携带稳定错误码 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE`。`@deepseek-ai/dsh-tool-subagent-control` 导出可分别加载的工具插件：`send_message` 适配器只要求 `subagents`，而 `list_agents` 适配器在加载时同时要求 `subagents` 和 `sessionQuery`。因此，部署可以在既不安装也不加载会话查询的情况下使用 `send_message`；列表工具 fiber 会在必需服务可用前保持未激活状态，而其他直接服务消费方会收到同一项明确的调用时约定。这一段的依赖姿态——可选 `sessionQuery`、其错误码与列表工具的加载要求——同属被取代的读路径：现行列表约定以[取代记录](../architecture/2026-08-06-subagent-list-identity-projection.zh.md)为准；在那里 `sessionProjections` 是 `SubagentRuntime` 的必需注入，`listChildren` 直接读取它，投影注册表缺失会在激活期失败而非列表调用时失败，`SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`（会话存储缺席）仍是唯一的稳定可用性错误码。

`listChildren(parentSessionId, signal?)` 会把调用方的取消信号转发给 `traceSession()` 和条件性精确 `readEvent()` 操作。`listEvents()` 不接受取消参数，因此列表查询路径会在等待该操作的前后，以及每个候选处理完成后检查信号。如果取消信号触发后有查询操作以拒绝结算，服务会将结果归一化为 `SubagentError`，并携带稳定错误码 `CANCELLED`；后端中止错误或可映射为 diagnostic 的查询错误均不会逃逸，也不会使调用以成功的部分列表返回。

这条描述符读取路径是正确性基线，并不声称工作量只与直接 child 数量呈线性关系。令 D 为直接 child 候选数量，C 为每次持久化列表查询所扫描的持久化会话数量，L_i 为候选 i 的完整日志大小。一次语料追踪后，每个候选都会执行 `sessionQuery.listEvents(childId)`。没有描述符的候选会被排除；含有多个描述符的候选会直接产生 diagnostic，无需再次读取；只有恰好含有一个描述符的候选才会通过 `sessionQuery.readEvent({ sessionId: childId, seq })` 再次加载。此次读取返回的不可变会话 header 必须与追踪时观测到的相同，包括直接 parent 关系，并且读取目标仍必须是先前定位的描述符事件；任何不一致均视为该 child 损坏。对于只存在于持久化存储中的最坏情况，每次精确读取都会重复执行 `persistence.list()`、加载完整 child 日志并克隆其中的事件，因此忽略常数因子后的工作量为 O(D × C + Σ L_i)；恰好含有一个描述符的候选承担两次这类成本，其他候选只承担一次。存活候选同样会对其完整日志取得一份分离的内存快照；读取其描述符时则会取得两份。会话查询通过 `inspect()` 解析持久化候选：已经是当前格式的恢复留在内存中，受支持的历史正文读取则可能先发布迁移并修复后的当前 generation。列表查询不会创建 Agent，也不会追加目录、描述符或修复事件，但其首次历史读取并非存储只读。第一版接受这些重复读取，将其作为无索引的正确性基线，但部署必须将语料总量和 child 日志大小，而不仅是直接 child 数量，视为容量约束。对模型隐藏的描述符始终位于对话 surface 之外，并且会在压缩后保留，因此经过压缩和未经压缩的 child 必须枚举出相同结果。

如果实测规模日后需要索引，该索引属于派生状态：会话 header 和 child 描述符仍是权威信息，重建或损坏回退必须复现相同结果。索引不能成为第二个鉴权来源，也不能让尚未发布的 child 变得可见。

### `list_agents` 约定

`SubagentRuntime.listChildren(parentSessionId: SessionId)` 返回 `Promise<SubagentListEntry[]>`，其中的单个数组不会将 child 与 diagnostic 分开，而是保留追踪结果中的候选顺序。`SubagentListEntry` 是一个由只读 `kind` 判别的封闭联合类型：

- `kind: 'child'` 携带只读的 `id: SessionId`、`mode: 'one-shot' | 'continuable'` 和 `activity: 'running' | 'inactive'`；可继续 child 携带 `label: string`，一次性 child 则携带 `label?: string`；
- `kind: 'diagnostic'` 携带只读的 `id: SessionId` 和 `reason: 'corrupt' | 'unsupported' | 'unavailable'`。

有效描述符产生一个 child 条目，逐 child 检查失败产生一个 diagnostic 条目，缺少描述符的候选不产生条目。`mode` 是持久化创建策略；`activity` 是进程本地语料快照。活动状态既不是 `AgentStatus`、管理器内部的 Activation 状态，也不是持久化结果，结果不公开内部 `createdAt` 排序键。成功完成、失败、取消和停止原因等精确 Activation 状态与持久化结果需要单独的持久化激活记录，不在本功能范围内。

面向模型的 `list_agents` 工具接受一个可选的 `scope: 'children' | 'descendants'` 参数，从当前执行 Agent 推导根 id，并在执行或渲染前通过显式的 request-to-spec 步骤解析请求（`undefined` → `children`）。解析后的 `children` scope 调用 `SubagentRuntime.listChildren(rootSessionId)`，`descendants` scope 则调用 `SubagentRuntime.listDescendants(rootSessionId)`。其内部输出投影中的 `id` 与 `parent` 会一直保持为品牌化的 `SessionId` 值，直到工具 JSON 边界。它保留 diagnostic，丢弃 `one-shot` child 条目，状态取自在线 Agent 注册表——driver 活跃为 `running`，驻留但处于轮次之间为 `idle`，没有在线 Agent 时为 `ready`（可恢复而非终态）——然后按稳定目录顺序渲染 `<id> [<status>] — <label>` 或 `<id> [diagnostic: <reason>]`。`descendants` scope 从一份实时优先语料按稳定 pre-order 展平完整树，遍历普通与一次性中间节点以发现更深的可继续 agent，依据枚举生命周期重新校验每个冷候选，并为每个条目附加 `parentId`／`depth`。工具会在 label 之前插入 ` parent=<id> depth=<n>`；`parent` 是持久化直接 parent 会话 id，可能指向被省略的普通会话。对于当前调用方，只有 depth-1 child 条目可作为 `send_message` 候选，更深的 child 条目则可供 `interrupt_agent` 选择（[中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)）。发现结果只是提示——follow-up 权限仍仅属于确切直接 parent，中断权限仍由服务的在线 lineage 检查决定。空投影渲染为 `(no subagents)`。

在已被取代的追踪读路径中，diagnostic 使用三种固定原因。格式错误的事件 surface、精确加载 child 时发现的 header 冲突、读取结果中的不可变 header 与追踪到的候选不一致或不再指向请求的直接 parent、读取目标不再是先前定位的描述符事件、格式错误的描述符内容和多个描述符事件映射为 `corrupt`。未知描述符版本映射为 `unsupported`。逐 child 读取产生的 `SESSION_QUERY_SESSION_NOT_FOUND`、`SESSION_QUERY_EVENT_NOT_FOUND` 和 `SESSION_QUERY_PERSISTENCE_FAILED` 映射为 `unavailable`。这项阶段边界是有意为之：初始追踪期间发生持久化故障会让操作失败，而同一故障如果始于候选读取期间，可能会让每个受影响的 child 分别产生一条相同的 `unavailable` diagnostic；第一版既不合并这些 diagnostic，也不会把它们提升为全局失败。缺少描述符则作为非 subagent 排除，且不产生 diagnostic。配置错误、窗口错误和未识别的失败不属于 child diagnostic，会作为操作失败继续向上传播。每条 diagnostic 都标识 child id 及原因，不暴露对模型隐藏的描述符内容；系统会排除该候选，而其他健康的 sibling 仍然可见。系统绝不会读取不属于追踪结果直接后代的会话，也不会为它们产生 diagnostic。

diagnostic 是瞬时查询结果，不属于会话事件或目录状态。推导 diagnostic 时，除了产生该结果的 `listEvents()` 或条件性 `readEvent()` 操作外，不会执行额外加载。

第一版不提供 child 删除操作。如果后续产品行为会删除 child 会话，持久化列表会自然移除已删除的 child；任何未来的派生索引都必须移除或 tombstone 同一条目，避免 `list_agents` 保留陈旧状态。

## 已考虑的替代方案

**将列表查询并入激活 RFC。** 按 id 持久化描述符和从持久化存储恢复无需 parent 到 child 的枚举。保持查询独立，可让 `send_message` 落地时不必同时承担列表状态、扫描性能或删除行为。

**直接通过 `SessionPersistence.list()` 重建谱系。** 这种做法会重复实现会话查询中的实时优先语料合并、不可变 header 一致性检查、直接 child 追踪和确定性排序。列表查询应使用现有可信查询服务，只增加 subagent 特有的描述符校验与渲染。

**列出每个已追踪的 child 会话。** `parentSession` 能证明谱系，却不能证明 child 是 subagent：普通会话 fork 也使用这个 header 字段。列表查询还必须读取并校验描述符。

**为 `SessionHeader` 添加 `kind` 判别字段。** header 仍不会携带校验或恢复可继续 subagent 所需的重建数据，因此列表查询无论如何都必须读取描述符。将描述符作为唯一的 subagent 判别信息，可避免引入第二个分类来源。

**使用存活的 Agent 注册表作为目录。** 系统会在 Activation 结算后有意 dispose 它，而且注册表状态会在重启时消失，因此无法支持持久化发现。

**使用进程内 Activation map 作为第二个目录。** 这种做法能公开管理器驻留状态，却会让会话发现查询与物化及结算耦合，引入另一套排序时钟，并让同一个 child 在其生命周期内改变候选来源。第一版只列出已经发布的逻辑会话，并将 `SessionRecord.live` 视为其快照状态。

**让列表查询经过基于 Activation 的继续执行管理器。** 管理器负责驻留状态并要求 `agents`，而列表查询只解释会话查询事实。让读取经过该管理器会强制引入无关的运行时服务，并使发现能力随 Activation 控制一同消失，因此列表查询直接由 `SubagentRuntime` 负责。

**按当前提供方可用性过滤。** 提供方注册状态属于进程本地状态，即使描述符仍然持久存在，该状态也可能发生变化。即使继续执行不依赖提供方，过滤仍可能隐藏持久化或存活 child。因此，列表查询根据描述符确立持久化身份，而 `send_message` 在消息送达时执行权威的鉴权与驻留状态检查。

**持久化 parent 会话目录事件。** 直接 child header 已经提供持久化枚举种子，child 描述符则是重建的权威信息。第二份 parent 日志会重复状态，并造成跨会话顺序和陈旧条目行为，却无助于按 id 恢复。

**要求每次底层启动都提供显示标签。** 这会保证 UI 文本一致，却会把展示关注点引入 workflow、传输、测试和程序化启动约定。底层请求保持标签可选；高层委派与继续执行 API 在本就拥有该概念时提供标签，UI 消费方则为无标签的一次性 child 选择回退展示。

**某个 child 无法加载时让整次列表查询失败。** 这种做法不会让损坏问题被忽略，但一个损坏的 sibling 会让每个健康 child 都不再可见。逐 child diagnostic 在保持每次排除明确可见的同时，也保留了发现能力。

**分别返回 child 和 diagnostic 数组。** 分离的数组会引入两个排序域，或者要求公开另一个排序键才能重建候选顺序。一个带判别字段的条目数组既能保留追踪顺序，也能保证 child 与 diagnostic 字段的类型安全。

**通过会触发修复的 `load()` 路径读取候选。** 对已经是当前格式的输入，复用恢复路径的 `load()` 语义会让每次发现都持久关闭中断尾部，而 `inspect()` 只在内存中保留这些 closer。历史检查可能已经发布一次迁移与修复，但这不会让重复的当前列表变成修改操作，也不会让它们每次都耦合到 `load()` 修复。

**立即为查询分页或设置上限（暂缓）。** 这可以限制一次结果的大小，但会使模型发现成为有状态操作，而且除非模型继续跟随 cursor，否则可能隐藏更早的 child。第一版没有 cursor、分页参数或候选数量上限配置，而是返回经稳定排序的完整集合；如果实测规模需要限制，服务级限制仍留待后续决策。

## 测试

- `packages/subagent/subagent/tests/service.spec.ts` 固定两种模式下的描述符 v2 解析，并证明无标签的底层启动会在分发给提供方之前解析出一次性描述符。`packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` 证明本地驱动会在初始轮次内追加该描述符，在取消落入工厂到 run 的交接窗口时返回已发布 id，并让结果与句柄释放失败保留在独立通道中。委派工具测试固定其现有显示说明的传递，并保留相互独立的结果与 dispose diagnostic。
- `packages/subagent/subagent/tests/list-children.spec.ts` 针对由会话存储、JSONL 持久化、spawn/fork 提供方、subagent 服务与投影注册表构成的真实组合——不含查询服务——以无密钥方式钉住现行读取路径：无持久化时的仅存活列表；投影注册表缺席时服务无法激活（其必需注入 seam），会话存储缺席时即使零 children 也响亮报 `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`；三级阶梯（存活 child 从不检查、冷 child 恰好检查一次，以及缓存命中、key 缺席、服务缺席、行中毒四个第二级用例）；多描述符 last-wins 取末者；载荷格式错误与未知版本诊断为 `corrupt`；冷检查失败成一条 `unavailable` diagnostic 并在下次列表重试；fork seed 中的祖先描述符按该身份列出；外部 unit 折叠失败在存活与冷两条路径上按 child 收纳为 `corrupt`；按 `createdAt` 再按 id 排序且不列普通 fork；提供方缺失时不排除 child；压缩与未压缩的孪生 child 列表结果一致；持久化列表失败使整次枚举失败；取消稳定归一化为 `CANCELLED`；带类型的稳定错误码；以及后代列表的迭代式稳定 pre-order、穿过普通与一次性中间节点、带位置 diagnostic、生命周期复验与取消。一个伴随规格(已随查询式读取路径一起退役)曾在导入普通 subagent surface 时拒绝对可选 session-query 运行时的 eager 求值。
- `packages/subagent/tool-subagent-control/tests/list-agents.spec.ts` 固定 `list_agents` 的 schema（一个可选 `scope` 枚举）、只保留可继续 child 且排除健康的一次性 sibling、同时保留 diagnostic 的投影、由注册表推导的 child／diagnostic／空结果文本形式、带持久化 label 的已结束 child 端到端列表、descendants scope 在在线 waiting 分支上的 pre-order parent/depth 注释、两个 scope 的取消信号转发、无调用 agent 时的拒绝、要求 `agents` 但不再注入 `sessionQuery` 的加载约定，以及 HMR dispose。
- 无密钥 SDK 快照场景 [`subagent-list-agents`](../../../../snapshots/sdk/subagent-list-agents/) 使用仅限快照的 `subagent/end` 标记为第二个 parent 轮次设置边界，随后针对 subagent 服务、投影注册表和 JSONL 持久化真实执行 `list_agents`，渲染 `<id> [ready] — <label>`。
- 归属方本地的预期输出测试 `apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts` 钉住现行列表的模型可见诊断分类，包括无描述符的定局 child 以 `corrupt` diagnostic 出现。
- 无密钥 ACP 快照场景 `subagent-published-run-failure` 会发布一个真实的一次性 child，注入相互独立的 run result 与 handle dispose 失败，并在 parent 工具结果中保留两项 diagnostic。

## 影响

- 会话追踪会观察完整的逻辑语料，随后描述符校验会读取每个直接 child 的日志一次，并对恰好含有一个描述符的候选读取两次。对于只存在于持久化存储中的最坏情况，工作量为 O(D × C + Σ L_i)，而不只是 O(D)，因为每次精确读取都会重新扫描持久化存储，并加载和克隆候选的完整日志。后续的派生索引必须保持相同的鉴权、逐 child diagnostic 和回退行为。
- 语料构建是一个全有或全无的信任边界：一处存活／持久化 header 冲突就会导致初始追踪失败，并隐藏原本健康的 sibling。只有初始追踪成功后，逐 child 隔离才会生效。
- 对已经是当前格式的存储，撕裂的 child 尾部会被呈现而非修复：`inspect()` 返回有效的已存储前缀，因此写入中途被打断的 child 在恢复路径的修复加载将其关闭之前，可能以较短的日志形式出现在列表中。历史输入会先迁移并修复，再应用这项当前检查行为。
- 没有删除操作，因此只要 child 会话仍保留在持久化存储中，它们就会继续出现在列表里，但存活 Agent 资源仍由驻留 Activation 数量限制。
- 服务会返回每个直接且由会话支撑的 subagent 和 diagnostic，不设 cursor 或候选数量上限。稳定排序可使结果确定；模型投影避免了一次性 child 带来的上下文增长，但可继续 child 的数量仍无上限。
- `running` 和 `inactive` 是进程本地语料快照，而非结果或消息送达承诺。另一个进程可能在当前进程将某个持久化 child 报告为 `inactive` 时激活它；跨进程准确性需要共享租约。
- 持久化生命周期模式是一次发布前的描述符格式变更：版本 2 会将旧版版本 1 描述符拒绝为不受支持。现在，每次由本地会话支撑的启动都会产生一个小型日志事件，使 UI 和其他服务消费方无需重放模型可见的工具结果即可对一次性历史进行分类。
- 一次性会话持久化仍为尽力执行。一次性 child 在存活期间可见，dispose 后只有在其会话检查点到达持久化存储时才可继续被发现；目录参与不会像可继续激活那样增加必需的最终 flush，也不会把持久化失败变为 run 失败。可继续启动无需提前 flush 描述符，因为描述符会随创建 seed 一同携带，并且每条 Activation dispose 路径都会执行必需的最终检查点，包括提示词准入受阻之后。
- 远端 ACP 一次性运行仍不在目录中，因为它们不会发布可供 `traceSession()` 发现的本地 child 会话。若要枚举这些运行，需要单独的持久化本地记录，不能假装远端生命周期 id 就是会话 id。
