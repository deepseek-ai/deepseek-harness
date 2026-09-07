# Agent Note: Web subagent 目录与用户继续交互

Status: implemented

[English](2026-07-27-web-subagent-conversations.md) | 中文

## 问题

由会话支撑的 subagent 具有持久化身份、持久化 transcript（文本记录）与直接 child 目录，但普通会话谱系无法将它们与 fork 区分开，也无法证明其描述符 mode 与继续执行授权。否则，绑定到 agent（智能体）的通用 Host 操作可能在其直接 parent 继续执行 owner 之外恢复或驱动 child。

浏览器必须遵守[可继续 subagent 约定](../../implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)：一个可继续 child 在进程内最多只能有一项 Activation，只能通过确切的存活直接 parent 接受后续工作，并将 agent inbox 用作唯一的 FIFO。查看历史不得创建 Activation。inbox 消息一经接受，HTTP 调用方既不拥有其执行过程，也不会获得取消句柄。

UI 还必须保留[持久化目录](../../archived/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)的成员、mode 与 diagnostic。共享服务报告采用实时优先规则的语料活动状态，而 Web 投影会将其替换为确切 child Agent driver 的 `running` 或 `inactive` 状态。这两种活动状态都不是持久化结果，也不承诺继续执行会成功。

## 决策

Web 产品通过页头的当前 title 谱系区域公开选中会话中由会话支撑的直接 subagent。用户可以懒加载展开后代目录，并在现有对话区域中打开任一 mode。one-shot child 永久只读。可继续 child 只有在其确切直接 parent agent 存活时才接受用户后续消息；否则，其持久化 transcript 仍然可读，并附带恢复说明。

每个打开的 child 都携带目录派生地址 `{ parentSessionId, childSessionId, mode }`。选择专用历史与提示词传输的是包含 mode 的地址，而不是谱系或粗粒度 origin 标记。历史操作会从持久化存储读取会话，而不触发激活。可继续提示词通过 `subagent.prompt` 携带 Queue 或 Steer 投递，并在 inbox 接受消息时以 `{ messageId }` 成功返回；它不会公开 Activation、等待完成或返回结果。相邻 Agent 的模型消息使用单独拥有的固定 Steer 操作。

通用 Host 领域遵守同一所有权边界。`session.history` 与 `session.fork` 的源端会读取已附加 Session 或检查持久化存储，而不获取 Agent；history 从所检查的确切前缀归并冷态投影值，fork 则发布一个普通的独立会话。绑定到 Agent 的通用会话、命令与目标路由会对由会话支撑的 subagent 返回 `agent-busy`；显式 id 的 `session.create` 接纳与仅针对已附加会话的队列控件亦然。拒绝分类器接受粗粒度 `origin` 标记、会话自身后缀中的 `subagent/descriptor`，或 parent 对其确切的存活运行时所有权；这些信号只会阻止通用路径取得所有权，绝不取代目录 mode 或直接 parent 授权。

停止一个已寻址 child 绝不回退到 `session.cancel`。浏览器 prompt 投递只负责消息被 inbox 接受前的准入，不授予取消句柄；正在运行的可继续 child 通过专用的 `subagent.interrupt` 路由停止，遵循[当前轮次中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)，该约定会停放并保留待处理工作，而不是将其丢弃。one-shot child 在 Web 端仍不可取消。

本决策涵盖 Web 端发现、transcript 查看与经 parent 授权的用户继续交互。它不会让 subagent 成为用户独立所有的对象；这类产品仍然属于[交互式 side session](../../proposed/feature/2026-07-08-interactive-side-sessions.zh.md)。

## 设计上下文

Figma 中的 [subagent 列表](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-14602&p=f)、[层级展开](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-15917&p=f)与 [child 对话](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=388-18584&p=f)画框是非规范性的交互与视觉参考。本记录负责生命周期、协议与失败语义。

| 设计意图 | 已交付约定 |
| --- | --- |
| 会话页头可打开紧凑的 child 列表。 | 触发器会汇总仅含 subagent 的完整后代谱系；树按服务顺序显示每个直接目录条目，包括已禁用的 diagnostic。 |
| 选择一行会复用对话 UI。 | 已寻址历史绝不激活 child；只有 parent 存活的可继续行才保留普通输入框。 |
| 嵌套 agent 会逐层展开。 | 每行携带一层 `hasChildren` 快照；展开时会立即预留已知直接后代行，随后仍只加载该行的直接目录，并保留其自身的 parent 地址。 |
| 条目显示 label、状态、token 用量与活跃耗时，同时避免侧边栏条目重复。 | mode 与 `running`／`inactive` 活动状态会同时以文字和视觉呈现；可选 title、持久化 token 用量与活跃轮次耗时来自列表保留的投影值。紧凑耗时从一天起省略更小的单位，而悬停和无障碍名称仍保留精确的整秒数。`SessionHeader.origin` 会移除重复的导航条目，但不授予任何能力。 |

## 产品约定

只有当完整的直接目录空响应与会话摘要投影相符，二者均表明没有已知的 subagent 后代时，才不显示后代数量控件。普通会话会用斜杠分隔当前 title 和该数量控件。每一级 subagent 面包屑都将紧凑的 12px title 与固定显示的双向箭头组合成一个控件：当前面包屑使用主标签颜色和 500 字重，祖先则使用三级标签颜色和 400 字重。悬停组合控件 150ms 后会打开其直接 parent 目录；浮层菜单具有短暂的跨越宽限时间，ArrowDown 保留为键盘入口。点击祖先会取消待触发的悬停、关闭已打开的目录，并且只向上导航。每个直接 parent 目录都可切换 sibling，并会加粗其选中行；目录 label 优先于会话摘要 title，缺失的每个切换器目录都会自动刷新。只有当前 subagent 会追加自己的后代数量控件。过长的 title 会在固定箭头之前截断。数量触发器会统计经不间断的 `origin: 'subagent'` 谱系可达的每个已知会话摘要后代，在普通 fork 处停止，并在任一计入统计的后代处于 `running` 时显示活动仍在进行。由于普通侧边栏行会隐藏 origin 为 subagent 的会话，Workspace 浏览器会在每个可见的普通行上索引同一条不间断谱系：任何运行中的后代都会让该行显示蓝色活动指示器，并在悬停与无障碍文本中给出确切数量，同时不会把空闲 parent 描述为正在运行。普通 fork 会开启单独的聚合子树。待处理交互优先于 parent 的运行中状态；二者无论哪一项存在都会保持为主要状态，而后代活动则成为悬停与无障碍状态中的第二项。两者均不存在时，后代活动优先于未查看的完成提醒；最后一个运行中的后代停止后，该提醒会恢复。每个健康的直接目录行都携带读取时的 `hasChildren` 提示，该值只根据持久化 `origin: 'subagent'` 的直接谱系 header 派生；正常的健康与 diagnostic subagent 候选都会携带该标记，而普通 fork 不会。该预查不读取任何后代事件日志，展开后仍以描述符支撑的目录为权威依据。当摘要在该目录尚不存在时或在一次陈旧的空响应后确认已有后代时，该操作会保持可见，并且在打开它以刷新目录之前仅显示禁用的加载行；仅由摘要支撑的行绝不会提供导航能力。UI 会在交互前就省略已知叶子节点的展开控件；该提示不承诺 child 会一直是叶子。已展开的直接目录加载期间，已知谱系会为每个直接后代预留一行禁用的加载行，而不会递归获取后代目录。随后树会呈现可继续与 one-shot 行；one-shot 的可选 label 缺失时，回退到其会话 id。损坏、不受支持或不可用的候选仍以禁用的 diagnostic 行显示。

`running` 表示在 Host 采样边界，确切 child Agent driver 正在处理工作；`inactive` 表示该 driver 空闲或不存在。UI 不会把任一值解释为成功、失败、取消、完成状态或可恢复性。`subagent.list` 提供当前 driver 状态基线，`host/session-status` 会就地更新已知活动状态，请求内回放会阻止更早发起但尚未完成的列表响应覆盖较新的状态转换，`host/session-removed` 则会使已知行恢复为 `inactive`；重连时会读取新的基线。直接 subagent 的 `host/session-added` 帧会立即把任何已加载的 parent 行翻转为 `hasChildren: true`，并使这项正向提示不被更早发起但尚未完成的目录响应覆盖；受影响分支打开期间，成员、label、mode、diagnostic 与权威快照仍需要通过去抖动的 `subagent.list` 刷新来更新。消息投递时仍以提示词响应为权威依据。

健康行会复用列表镜像中保留的标准会话投影。token 用量数值会汇总持久化日志中四个互不重叠的 `tokenUsage` 桶。`subagentTiming` 会在每个描述符处重置，使继承的 fork 种子不会计入 child 总量；它会累加已完成的 `turn/start` → `turn/end` 时段，并携带未结束轮次同一切面的 `active.since` 和 `active.through` 边界。该轮次保持未结束期间，现有会话事件会推进 `active.through`；菜单不会增加单独的计时器或日志读取，且仅在有已知后代处于运行状态时才推进其本地时钟。不足一天时，菜单会以整秒格式化时间；达到一天后的视觉值最多保留两个相邻单位，其中月份按近似 30 天计算，年份按近似 365 天计算，而悬停信息与无障碍名称会保留精确的天／小时／分钟／秒耗时。对 inactive 行，菜单以 `active.through` 为被中断未结束轮次的上界，因此陈旧投影绝不会借用更新的会话元数据，且重新打开菜单绝不会让已完成工作重新计时。这两项指标都不蕴含持久化结果语义。

选择一行后，系统会先记录其确切地址，再打开常驻客户端 `Session`。历史分页、事件 fold、工具渲染意图、title 与实时 mux 归并都会复用普通对话机制。面包屑导航只会沿 `origin: 'subagent'` 行的父链接逐级回溯，包含第一个普通 owner，并让普通 fork 保持单层。每一级 subagent 面包屑都会获得其直接 parent 的 sibling 目录，并在目录可用时采用其中的 label。从已寻址 subagent 创建 fork 时，会生成具有直接源谱系的普通 fork，并将其附加到最近拥有 Workspace 的祖先。目录是一棵 ARIA 树，支持懒加载式 ArrowRight／ArrowLeft 展开与折叠、线性 ArrowUp／ArrowDown 导航、Home／End、Escape 以及焦点恢复。

one-shot 行始终会用文案替代输入框，说明执行记录为只读。可继续行仅在 `parentAvailable` 为 false 且 child 未在运行时如此；parent 离线但仍在运行的 child 保留普通输入框，并禁用其输入区和 Send 操作，让独立的 Stop 与在线 QueueDock 控制保持可达，停止后只读替代恢复。parent 在线时，即使 child 正在运行，普通 Enter／Cmd+Enter 偏好也会选择 Queue 或 best-effort Steer。对在线可继续 child，QueueDock Edit、Remove 与 Steer 在 parent 离线时仍可用；独立 Stop 经由 `subagent.interrupt` 路由（[中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)）。提示词失败会通过普通错误行为保留草稿。

已寻址 child 视图不提供绑定到 agent 的辅助控件。具体而言，模型选择器与 `/model` contribution 不会调用普通 `session.models` 或 `session.selectModel`；Host 也会拒绝任何意外调用，而不是在直接 parent 继续执行路径之外激活持久化 child 历史。

## 宿主适配器与协议约定

`@deepseek-ai/dsh-subagent` 拥有浏览器安全的生成 `subagent` Remote 命名空间：

- `subagent.list` 接受 `parentSessionId`，调用 `ctx.subagents.listChildren(parentSessionId, signal)`，返回完整有序的条目以及每个健康行的布尔 `hasChildren` 快照，把每个健康行的语料活动状态替换为其确切 Agent driver 是否正在运行，并说明当前能否从 `ctx.agents` 解析出确切 parent。
- `subagent.history` 接受包含 mode 的完整地址与普通页参数。它对照直接目录校验 child 与 mode，通过 `ctx.sessionQuery.readSession()` 读取，再次检查直接谱系，并在不发布 agent 的情况下返回普通原始事件、渲染意图、分页与由 Host 计算的会话投影基线。
- `subagent.prompt` 只接受 `mode: 'continuable'` 地址、`delivery: 'queue' | 'steer'` 与上传形态的 `PromptContentPart[]`；Host 在投递前把图片部分准入并持久化为持久引用（[图片投递](../../archived/bug-fix/2026-08-27-steer-followup-image-delivery.md)）。它要求确切的存活 parent，重新校验目录地址，使用 continuation manager 共享的人类投递准入，并返回已接受的 `MessageId`。

网关会将 parent 缺失、目录条目缺失或为 diagnostic、child 不可恢复或未授权、请求取消、图片准入或图片能力拒绝（`subagent/attachment-invalid`）以及继续执行准入暂时不可用等失败映射为类型化 RPC 错误。它不会公开描述符或提供方细节。list／prompt 竞态属于正常情况：权威依据是提示词操作的结果，而不是更早的可用性或活动快照。

查看持久化历史本身不会创建 mux 订阅。当后续消息物化冷态 child Activation 时，现有 Host 与 mux 流会发布其生命周期与事件。重新连接时，系统通过 `subagent.history` 重建已寻址窗口。

普通 `session.history` 路由对于普通会话和 subagent 会话同样只执行观察，但它既不携带目录地址，也不授予继续执行权限。每条需要 Agent 的普通路由都会在恢复冷会话前经过共享所有权栅栏；`session.cancel` 保留该栅栏。`session.updateQueue` 只有一个目标本地例外：目标是在线 child，且其当前 projection identity 为 continuable 并来自自身的非 seed suffix；one-shot、缺失、未知、损坏、仅含 seed identity 或冷 child 仍受栅栏阻挡。

适配器仍位于生成的 Remote 命名空间之后；`dsh-host-webserver` 仍作为载体。浏览器代码通过现有连接包导入约定，绝不直接访问宿主 `ctx`，从而保持[已归档的 GUI RPC 分层决策](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)。

## 客户端对象层与呈现

不依赖 React 的运行时负责目录、单次并发刷新、保留的地址、可用性提示、传输选择，以及每个列表行当前投影值的引用稳定映射。再次选择已知 child 时会保留其地址，避免导航静默切换到普通会话 API。缺失的中间面包屑地址可以从已加载的祖先目录恢复，但在用户选择该面包屑之前不会保留为传输地址，也不会创建 scope。恢复的导航会持久化包含 mode 的完整地址。

目录通过标准 `useSessions` 快照传递。组件局部状态负责菜单可见性、已展开分支、焦点与悬停计时器。`ui-conversation` 为当前普通 title 和每一级 subagent 面包屑声明谱系 slot，传入纯数据形式的面包屑身份与显示文本，并为祖先传入向上导航回调；普通 title 由 render site 保留为回退。`@deepseek-ai/dsh-client-ui-subagent` 以直接 parent 目录导航占用每个谱系 slot，并根据普通 owner props 选择按原因区分的只读编辑器。组件只接收派生 props 与回调，绝不接收 `ctx`。

每个进程内 subagent child 都会在发布前写入 `SessionHeader.origin: 'subagent'`。会话列表摘要与增量 Host 帧会投影该字段，使分组和扁平侧边栏省略重复的 child 行，同时保留普通 fork。同一条现有的 `host/session-added` 帧还会把已加载的直接 parent 行标记为可展开，而无需引入目录事件流。描述符 mode 与目录校验仍然是导航、继续执行和授权的权威依据。

该包现有的 `@label` source 仍然是独立的面向模型纯文本输入。它不会将 label 解析为地址，也不会获得继续执行语义。

## 默认 Web 组合

已交付的 Web 组合会在 JSONL 持久化旁挂载 SQLite 会话查询，并将 spawn 与 fork 后台委派配置为可继续模式。它还会挂载面向模型的 `send_message` 与 `list_agents` 适配器，以保持 coordinator 对等性，但 GUI 会通过宿主 RPC 域调用共享的 `SubagentRuntime`，而不是调用模型工具。one-shot child 仍在目录中可见且只读。

## 备选方案

**对已寻址 child 使用普通会话 API。** 不予采纳，因为通用历史不携带目录 mode 校验，而绑定到 Agent 的通用控件会有意拒绝 subagent，不会授予直接 parent 继续执行授权。

**将适配器放入 webserver。** 不予采纳，因为目录与继续执行是通道无关的客户端能力；webserver 只承载已校验的消息。

**把由 Host 支撑的文件与会话引用放进本包。** 不予采纳，因为目录与已寻址 child 呈现依赖 subagent 谱系，而组合引用发现是独立的 Host 功能，由 [`ui-reference`](../../../../packages/client/ui-reference/README.zh.md) 消费。

**自动恢复缺失的 parent。** 不予采纳，因为继续执行要求确切的存活直接 parent。child 导航不得改变 parent 生命周期。

**公开普通取消操作。** 不予采纳，因为已获 inbox 接受的轮次会比其准入请求存续更久，且在本决定当时，继续执行约定未公开具备安全授权的取消句柄。后来的[当前轮次中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)以专用 subagent 路由补上了这项显式授权；回退到 `session.cancel` 仍被拒绝。

**只显示可继续 child。** 不予采纳，因为持久化目录有意描述由会话支撑的两种 mode。one-shot transcript 即使绝不接受后续消息，仍然有用。

**根据谱系推断 mode 或侧边栏过滤。** 不予采纳，因为普通 fork 共享 `parentSession`。由描述符支撑的目录负责提供 mode；单独的 `origin` 标记只是低成本的导航分类器。

**构建预先加载的递归树或专用目录流。** 就当前规模而言不予采纳。仅用于页头的一层可展开性预查会在不读取后代事件的情况下保证点击前的稳定性，而展开仍是懒加载式权威直接 child 读取；现有 Host 帧会更新活动状态、恢复 parent 行的可展开性，并触发有界的成员刷新。

**让 child 在 parent 消失后仍能独立交互。** 不予采纳，因为独立生命周期与用户所有权需要 side session 语义。

## 测试

- 宿主协议测试固定 schema（包括必需的布尔可展开性）、id 回显、mode 校验、非激活式历史、确切 parent 强制要求、FIFO 准入回执、取消与脱敏后的失败映射。
- 通用 Host 测试固定在不发布 Agent 的情况下读取已附加与冷态历史及执行 fork、冷态投影归并、按描述符／origin／运行时 owner 拒绝、拒绝显式 id 接纳，以及直接队列控制栅栏。
- 客户端对象测试固定已保留与已恢复的地址、one-shot 只读与取消拒绝、历史路由、可继续提示词与中断路由、屏蔽绑定到 agent 的模型控件、实时活动状态翻转（包括在途响应回放与 detach 回退）、subagent parent 可展开性翻转与成员刷新。
- jsdom 测试固定普通 title 分隔符、逐级合并的 subagent title 切换热区、嵌套 title 的 12px 字号、当前与祖先样式、选中行字重、目录 label 优先级、悬停延迟、向上点击抑制、保留箭头的截断、后代聚合计数与活动状态、侧边栏活动在嵌套谱系中的传播与普通 fork 边界、行状态优先级、token 用量总计、精确到秒的运行中耗时与冻结后 inactive 耗时、采用自适应单位的长耗时及其精确无障碍文本、目录缺失或为陈旧空目录时由摘要支撑的根操作、已知加载行的形态、混合 mode 行、点击前的叶子展开控件、diagnostic、后代懒加载展开、直接 parent 地址、键盘行为与两种只读原因。
- 无密钥的组装 Web 快照包含一个具有持久化 token 用量的 inactive 可继续 child、一个具有确定性长耗时的 inactive one-shot sibling 和一个持久化 grandchild；它会固定触发器在一次陈旧的空目录响应后仍显示三个后代，并固定 token 用量与计时行、自适应长耗时呈现及聚合 `running` 状态转换，在不激活的情况下展开、打开持久化历史、准入一条用户 FIFO 后续消息、归并 child mux 事件，并证明 one-shot 历史仍然只读。另一个独立的组装场景会在 LLM seam 处保持一个真实的 child Agent 轮次进行中，同时固定页头和可见空闲 owner 行中的聚合运行状态，随后在 teardown 期间取消该轮次。
- 导航测试固定仅含 subagent 的面包屑导航、从 subagent 创建 fork 时的 Workspace 归属，以及 `origin: 'subagent'` 侧边栏过滤，同时不隐藏普通 fork。

## 后果

- 目录读取可能重新扫描持久化谱系与每个直接候选的描述符日志，但可展开性只复用该追踪中已有的后代 header；Web 活动基线会为每个健康行增加一次 Agent 注册表查找，随后使用现有实时帧，而 token 用量与耗时会复用投影基线和推送，无需按行读取日志，成员刷新则保持去抖动和单次并发。
- parent 可用性、child 活动状态与 `hasChildren` 都是快照。列出之后，发布、dispose（资源释放）、其他发送方或其他进程都可能抢先改变状态；类型化提示词失败仍属预期行为。
- child 可能在历史获取与 mux 订阅之间发布，因此现有序号归并也涵盖从冷态转为存活的已寻址路径。
- 持久化 origin 会为 child header 与列表投影添加一个有意保持弱约束的产品分类字段；它不能变成授权捷径。
- 除对正在运行的可继续 child 的当前轮次 Stop（[中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)）之外，UI 不提供 child 取消、持久化结果、Activation 身份、删除或可独立交互的离线 mode，其文案不得暗示这些能力已经存在。活跃轮次耗时度量的是已记录工作，而非 Activation 驻留时间。
