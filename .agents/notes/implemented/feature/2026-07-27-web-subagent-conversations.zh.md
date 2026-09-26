# Agent Note: Web subagent 目录与用户继续交互

Status: implemented

[English](2026-07-27-web-subagent-conversations.md) | 中文

## 问题

由会话支撑的 subagent 具有持久化身份、持久化 transcript（文本记录）与直接 child 目录，但普通会话谱系无法将它们与 fork 区分开，也无法证明其描述符 mode 与继续执行授权。否则，绑定到 agent（智能体）的通用 Host 操作可能在其直接 parent 继续执行 owner 之外恢复或驱动 child。

浏览器必须遵守[可继续 subagent 约定](../../implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)：一个可继续 child 在进程内最多只能有一项 Activation，只能通过确切的存活直接 parent 接受后续工作，并将 agent inbox 用作唯一的 FIFO。查看历史不得创建 Activation。inbox 消息一经接受，HTTP 调用方既不拥有其执行过程，也不会获得取消句柄。

UI 还必须保留[持久化目录](../architecture/2026-09-01-parent-owned-subagent-catalog.zh.md)的成员与 mode。Web 投影会添加确切 child Agent driver 的 `running` 或 `inactive` 状态。这两种活动状态都不是持久化结果，也不承诺继续执行会成功。

## 决策

Web 产品通过页头的当前 title 谱系区域公开选中会话中由会话支撑的直接 subagent。用户可以懒加载展开后代目录，并在现有对话区域中打开任一 mode。one-shot child 永久只读。可继续 child 只有在其确切直接 parent agent 存活时才接受用户后续消息；否则，其持久化 transcript 仍然可读，并附带恢复说明。

同一个页头行还可以把 child 作为 `dsh-resource://subagentchat/session/<childSessionId>?parent=<parentSessionId>&mode=<mode>` 在右侧 Sidebar 打开。打开时优先使用独立分栏；无法分栏时回退到当前分栏。Sidebar tab 使用共享 Conversation Component Factory 渲染并省略宽度控制，因此主对话与嵌入式对话共用一套组装，而不共享布局界面。

每个打开的 child 都携带目录派生地址 `{ parentSessionId, childSessionId, mode }`。选择专用历史与提示词传输的是包含 mode 的地址，而不是谱系或粗粒度 origin 标记。历史操作会从持久化存储读取会话，而不触发激活。可继续提示词通过 `subagent.prompt` 携带 Queue 或 Steer 投递，并在 inbox 接受消息时以 `{ messageId }` 成功返回；它不会公开 Activation、等待完成或返回结果。相邻 Agent 的模型消息使用单独拥有的固定 Steer 操作。

通用 Host 领域遵守同一所有权边界。`session.history` 与 `session.fork` 的源端会读取已附加 Session 或检查持久化存储，而不获取 Agent；history 从所检查的确切前缀归并冷态投影值，fork 则发布一个普通的独立会话。绑定到 Agent 的通用会话、命令与目标路由会对由会话支撑的 subagent 返回 `agent-busy`；显式 id 的 `session.create` 接纳与仅针对已附加会话的队列控件亦然。拒绝分类器接受粗粒度 `origin` 标记、会话自身后缀中的 `subagent/descriptor`，或 parent 对其确切的存活运行时所有权；这些信号只会阻止通用路径取得所有权，绝不取代目录 mode 或直接 parent 授权。

停止一个已寻址 child 绝不回退到 `session.cancel`。浏览器 prompt 投递只负责消息被 inbox 接受前的准入，不授予取消句柄；正在运行的可继续 child 通过专用的 `subagent.interrupt` 路由停止，遵循[当前轮次中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)，该约定会停放并保留待处理工作，而不是将其丢弃。one-shot child 在 Web 端仍不可取消。

本决策涵盖 Web 端发现、transcript 查看与经 parent 授权的用户继续交互。它不会让 subagent 成为用户独立所有的对象；这类产品仍然属于[交互式 side session](../../proposed/feature/2026-07-08-interactive-side-sessions.zh.md)。

## 设计上下文

Figma 中的 subagent 列表、层级展开与 child 对话画框是非规范性的交互与视觉参考。本记录负责生命周期、协议与失败语义。

| 设计意图 | 已交付约定 |
| --- | --- |
| 会话页头可打开紧凑的 child 列表。 | 触发器统计 parent catalog service 返回的健康直接条目。 |
| 选择一行会复用对话 UI。 | 已寻址历史绝不激活 child；只有 parent 存活的可继续行才保留普通输入框。 |
| 嵌套 agent 会逐层展开。 | row 在自身 catalog 成功加载为空前保持可展开；展开时只加载该直接 catalog，并保留 row 的 parent 地址。 |
| 条目显示 label、状态、token 用量与活跃耗时，同时避免侧边栏条目重复。 | mode 与 `running`／`inactive` 活动状态会同时以文字和视觉呈现；可选 title、持久化 token 用量与活跃轮次耗时来自列表保留的投影值。紧凑耗时从一天起省略更小的单位，而悬停和无障碍名称仍保留精确的整秒数。`SessionHeader.origin` 会移除重复的导航条目，但不授予任何能力。 |

## 产品约定

直接 catalog 有子项或读取失败时显示 child 数量控件；空目录缺席、加载中或成功读取为空时均隐藏该控件。普通会话会用斜杠分隔当前 title 和该控件。每一级 subagent 面包屑都将紧凑的 12px title 与固定显示的双向箭头组合成一个控件：当前面包屑使用主标签颜色和 500 字重，祖先则使用三级标签颜色和 400 字重。悬停组合控件 150ms 后会打开其直接 parent 目录；浮层菜单具有短暂的跨越宽限时间，ArrowDown 保留为键盘入口。点击祖先会取消待触发的悬停、关闭已打开的目录，并且只向上导航。每个直接 parent 目录都可切换 sibling，并会加粗其选中行；目录 label 优先于可选的会话摘要 title，缺失的切换器目录在交互时加载。只有当前 subagent 会追加自己的直接 child 数量控件。过长的 title 会在固定箭头之前截断。触发器报告直接 catalog 的总数与运行数。普通侧边栏 row 隐藏 origin 为 subagent 的 Session，并从同一份已加载 catalog map 读取直接运行 child 数；Session summary 提供 activity，但绝不创建 membership。运行中的直接 child 使用共享的三级灰色 ongoing loading。待处理交互优先于 parent 的运行中状态；二者无论哪一项存在都会保持为主要状态，而直接 child activity 则成为悬停与无障碍状态中的第二项。普通 Workspace 行存在待处理的审批、计划审阅或问题时，会用紧凑的「待批准」「计划待审」或「待回答」替换相对时间；悬停与无障碍详情仍保留完整状态和相对时间。两种主要状态均不存在时，直接 child activity 优先于未查看的完成提醒；最后一个运行中的直接 child 停止后，该提醒会恢复。tree row 在 child catalog 缺席、加载中或失败时保持可展开，只有 catalog 成功加载为空后才成为已知叶子。加载时显示通用提示，不会从 summary 生成占位 row。tree 会呈现 continuable 与 one-shot row；one-shot 的可选 label 缺失时，回退到其 Session id。

`running` 表示子 Agent driver 正在处理工作；`inactive` 表示该 driver 空闲或不存在。Session 列表基线与状态事件提供活动状态，移除事件将完成的子代理标为 inactive 并保留其展示 projection。共享的父 `subagentCatalog` projection 提供成员关系。初始读取与推送值进入同一个 projection store，较新序号优先。[projection 消费决策](../simplification/2026-09-08-web-subagent-catalog-projections.zh.md) 说明加载、重连与同步取舍。提示词响应仍是投递时的权威依据。

健康行会复用列表镜像中保留的标准会话投影。token 用量数值会汇总持久化日志中四个互不重叠的 `tokenUsage` 桶。`subagentTiming` 会在每个描述符处重置，使继承的 fork 种子不会计入 child 总量；它会累加已完成的 `turn/start` → `turn/end` 时段，并携带未结束轮次同一切面的 `active.since` 和 `active.through` 边界。该轮次保持未结束期间，现有会话事件会推进 `active.through`；菜单不会增加单独的计时器或日志读取，且仅在有已知后代处于运行状态时才推进其本地时钟。不足一天时，菜单会以整秒格式化时间；达到一天后的视觉值最多保留两个相邻单位，其中月份按近似 30 天计算，年份按近似 365 天计算，而悬停信息与无障碍名称会保留精确的天／小时／分钟／秒耗时。对 inactive 行，菜单以 `active.through` 为被中断未结束轮次的上界，因此陈旧投影绝不会借用更新的会话元数据，且重新打开菜单绝不会让已完成工作重新计时。这两项指标都不蕴含持久化结果语义。

选择一行后，系统会先记录其确切地址，再打开常驻客户端 `Session`。历史分页、事件 fold、工具渲染意图、title 与实时 mux 归并都会复用普通对话机制。面包屑导航只会沿 `origin: 'subagent'` 行的父链接逐级回溯，包含第一个普通 owner，并让普通 fork 保持单层。每一级 subagent 面包屑都会获得其直接 parent 的 sibling 目录，并在目录可用时采用其中的 label。从已寻址 subagent 创建 fork 时，会生成具有直接源谱系的普通 fork，并将其附加到最近拥有 Workspace 的祖先。目录是一棵 ARIA 树，支持懒加载式 ArrowRight／ArrowLeft 展开与折叠、线性 ArrowUp／ArrowDown 导航、Home／End、Escape 以及焦点恢复。

one-shot 行始终会用文案替代输入框，说明执行记录为只读。可继续行仅在 `parentAvailable` 为 false 且 child 未在运行时如此；parent 离线但仍在运行的 child 保留普通输入框，并禁用其输入区和 Send 操作，让独立的 Stop 与在线 QueueDock 控制保持可达，停止后只读替代恢复。parent 在线时，即使 child 正在运行，普通 Enter／Cmd+Enter 偏好也会选择 Queue 或 best-effort Steer。对在线可继续 child，QueueDock Edit、Remove 与 Steer 在 parent 离线时仍可用；独立 Stop 经由 `subagent.interrupt` 路由（[中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)）。提示词失败会通过普通错误行为保留草稿。

已寻址 child 视图不提供绑定到 agent 的辅助控件。具体而言，模型选择器与 `/model` contribution 不会调用普通 `session.models` 或 `session.selectModel`；Host 也会拒绝任何意外调用，而不是在直接 parent 继续执行路径之外激活持久化 child 历史。

## 宿主适配器与协议约定

Session Controller 负责 catalog 与 history read；`@deepseek-ai/dsh-subagent` 负责 continuation control：

- `session.projections` 接受 `sessionId`，返回一次 live-preferred Session observation 的完整 projection 基线，不激活 Agent。Client 将基线写入标准 projection store；subagent 消费者选择 `subagentCatalog`。父 Agent 可用性来自 Session 列表摘要与生命周期事件。
- `session.page` 与 `session.follow` 接受包含 mode 的完整地址。它们在观察到的 cut 上校验 child header、直接 parent、descriptor identity 与 mode，随后在不发布 Agent 的情况下返回普通 raw event、pagination、live reconciliation 与 Host projection baseline。
- `subagent.prompt` 只接受 `mode: 'continuable'` 地址、`delivery: 'queue' | 'steer'` 与上传形态的 `PromptContentPart[]`；Host 在投递前把图片部分准入并持久化为持久引用（[图片投递](../../archived/bug-fix/2026-08-27-steer-followup-image-delivery.md)）。它要求确切的存活 parent，重新校验目录地址，使用 continuation manager 共享的人类投递准入，并返回已接受的 `MessageId`。

网关会将 parent 或目录条目缺失、child 不可恢复或未授权、请求取消、图片准入或图片能力拒绝（`subagent/attachment-invalid`）以及继续执行准入暂时不可用等失败映射为类型化 RPC 错误。它不会公开描述符或提供方细节。list／prompt 竞态属于正常情况：权威依据是提示词操作的结果，而不是更早的可用性或活动快照。

查看持久化历史本身不会创建 Agent。当后续消息物化冷态 child Activation 时，现有 Host 与 Session journal stream 会发布其生命周期与事件。重新连接时，系统通过 `session.follow` 重建已寻址窗口。

普通 `session.page` 与 `session.follow` 地址对于普通会话和 subagent 会话同样只执行观察，但它既不携带目录地址，也不授予继续执行权限。每条需要 Agent 的普通路由都会在恢复冷会话前经过共享所有权栅栏；`session.cancel` 保留该栅栏。`session.updateQueue` 只有一个目标本地例外：目标是在线 child，且其当前 projection identity 为 continuable 并来自自身的非 seed suffix；one-shot、缺失、未知、损坏、仅含 seed identity 或冷 child 仍受栅栏阻挡。

适配器仍位于生成的 Remote 命名空间之后；`dsh-host-webserver` 仍作为载体。浏览器代码通过现有连接包导入约定，绝不直接访问宿主 `ctx`，从而保持[已归档的 GUI RPC 分层决策](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)。

## 客户端对象层与呈现

不依赖 React 的运行时负责目录、单次并发刷新、保留的地址、可用性提示、传输选择，以及每个列表行当前投影值的引用稳定映射。再次选择已知 child 时会保留其地址，避免导航静默切换到普通会话 API。缺失的中间面包屑地址可以从已加载的祖先目录恢复，但在用户选择该面包屑之前不会保留为传输地址，也不会创建 scope。恢复的导航会持久化包含 mode 的完整地址。

目录通过标准 `useSessions` 快照传递。组件局部状态负责菜单可见性、已展开分支、焦点与悬停计时器。`ui-conversation` 为当前普通 title 和每一级 subagent 面包屑声明谱系 slot，传入纯数据形式的面包屑身份与显示文本，并为祖先传入向上导航回调；普通 title 由 render site 保留为回退。`@deepseek-ai/dsh-client-ui-subagent` 以直接 parent 目录导航占用每个谱系 slot，并根据普通 owner props 选择按原因区分的只读编辑器。组件只接收派生 props 与回调，绝不接收 `ctx`。

每个进程内 subagent child 都会在发布前写入 `SessionHeader.origin: 'subagent'`。会话列表摘要与增量 Host 帧会投影该字段，使分组和扁平侧边栏省略重复的 child 行，同时保留普通 fork。parent catalog projection 拥有 membership 与 tree structure 权威；descriptor identity 与精确 parent check 拥有 addressed history 与 continuation validation 权威。

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

**构建预先加载的递归树或专用目录流。** 就当前规模而言不予采纳。展开控件按需加载缺失目录，现有 control 帧传递完整 projection 更新。

**让 child 在 parent 消失后仍能独立交互。** 不予采纳，因为独立生命周期与用户所有权需要 side session 语义。

## 测试

- 宿主协议测试固定健康的直接 catalog schema、id 回显、mode 校验、非激活式历史、确切 parent 强制要求、FIFO 准入回执、取消与脱敏后的失败映射。
- 通用 Host 测试固定在不发布 Agent 的情况下读取已附加与冷态历史及执行 fork、冷态投影归并、按描述符／origin／运行时 owner 拒绝、拒绝显式 id 接纳，以及直接队列控制栅栏。
- 客户端对象测试固定已保留与已恢复的地址、one-shot 只读与取消拒绝、历史路由、可继续提示词与中断路由、屏蔽绑定到 agent 的模型控件、来自 Session 摘要与 Agent 销毁的实时活动状态、权威 catalog membership 与成员刷新。
- jsdom 测试固定普通 title 分隔符、逐级合并的 subagent title 切换热区、嵌套 title 的 12px 字号、当前与祖先样式、选中行字重、目录 label 优先级、悬停延迟、向上点击抑制、保留箭头的截断、catalog 直接计数与 activity、侧边栏直接 child activity、行状态优先级、token 用量总计、精确到秒的运行中耗时与冻结后 inactive 耗时、采用自适应单位的长耗时及其精确无障碍文本、通用加载提示、混合 mode row、ready-empty 叶子判定、descendant 懒加载展开、直接 parent 地址、键盘行为与两种只读原因。
- 无密钥的组装 Web 快照包含一个具有持久化 token 用量的 inactive 可继续 child、一个具有确定性长耗时的 inactive one-shot sibling 和一个持久化 grandchild；它会固定直接 catalog 数量、token 用量与计时行、自适应长耗时呈现及嵌套懒加载，在不激活的情况下打开持久化历史、准入一条用户 FIFO 后续消息、归并 child mux 事件，并证明 one-shot 历史仍然只读。另一个独立的组装场景会在 LLM seam 处保持一个真实的 child Agent 轮次进行中，同时固定页头和可见空闲 owner row 中的直接运行状态，随后在 teardown 期间取消该轮次。
- 导航测试固定仅含 subagent 的面包屑导航、从 subagent 创建 fork 时的 Workspace 归属，以及 `origin: 'subagent'` 侧边栏过滤，同时不隐藏普通 fork。

## 后果

- catalog read 只 fold 所选 parent 的 catalog projection。Web activity 来自 Session 摘要；token 用量与耗时复用 projection baseline 和 push，无需按 row 读取日志，投影读取保持 single-flight。
- parent 可用性与 child activity 都是快照。列出之后，发布、dispose（资源释放）、其他发送方或其他进程都可能抢先改变状态；类型化提示词失败仍属预期行为。
- child 可能在历史获取与 mux 订阅之间发布，因此现有序号归并也涵盖从冷态转为存活的已寻址路径。
- 持久化 origin 会为 child header 与列表投影添加一个有意保持弱约束的产品分类字段；它不能变成授权捷径。
- 除对正在运行的可继续 child 的当前轮次 Stop（[中断约定](2026-08-06-continuable-subagent-interrupt.zh.md)）之外，UI 不提供 child 取消、持久化结果、Activation 身份、删除或可独立交互的离线 mode，其文案不得暗示这些能力已经存在。活跃轮次耗时度量的是已记录工作，而非 Activation 驻留时间。
