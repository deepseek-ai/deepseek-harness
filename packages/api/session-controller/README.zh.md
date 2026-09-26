---
description: "Host 与 Client 会话控制：创建、恢复、提示、跟随历史并投影实时会话状态。"
kind: "package-reference"
---
# Session Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-session-controller` 拥有 Host 的 `ctx.sessionController` 服务，以及生成的 Client `session`、`skills` 和 `fileReferences` Remote namespace。它提供 Session 生命周期与历史、Host generation 模型目录、人工后台任务终止、工作区路径打开、用户可调用 skill（技能）发现和 Agent（智能体）范围的文件引用。当 Client 需要按 Session 寻址的操作时，请通过 API Gateway 使用它。

## 目录

- [使用本包](#use-this-package)
- [Client 引用](#client-references)
- [会话媒体引用](#session-media-references)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

历史页与 follow opening 快照为每个持久 Session 事件携带一条 `{ type: 'event', event: SessionWireEvent }` record。Client 把每条已接受 record 保留为一个持久 `SessionEventLikeEntry`；Assistant token 边界保留在 `assistant/message` 或 `assistant/attempt` 的紧凑流内。工具参数、结果内容、失败信息和 `tool/result.data.meta` 原样通过；控制器不解析工具定义、不运行展示转换器，也不附加 UI 数据。

Client journal 在发布 follow 快照、live entry 或历史页之前验证当前 Session 事件 envelope。它复用浏览器安全的 Session validator，检查必需的 surface marker、精确的 replacement endpoint、更早且唯一的 source seq、内嵌 Assistant 提供方元数据、request header 可选字段的省略规则以及工具错误一致性。无效 record 直接失败，不删除字段或归一化；范围成员与来源存在性仍由 Host 的持久日志检查。

每个 endpoint 都声明自己的激活策略。列表只读取持久化 header 与 projection cache row，绝不调用逐 Session stat 或打开冷 Session body。当前格式 cache identity 可以提供全部列表 hint；生命周期匹配的 predecessor cache 只能提供版本兼容的 title，作为可能过时的展示事实，绝不能作为权威 fold seed。搜索、附件、历史页、日志跟随、skill 发现和工作区路径打开可以在不激活 Agent 的情况下检查 persistence；`canOpenWorkspacePath()` 无需指定 Session 即可报告原生打开能力。取消要求 live 状态；queue 变更、模型、重命名、prompt 和文件引用操作可以解析或恢复普通 Session。提示词会在解析 Agent 或追加 Session 事件前，拒绝既没有非空白文本也没有附件的 content；queue edit 只接受非空文本 content。prompt 准入从注入的 [`fileUploads`](../../client/file-upload/README.zh.md) Host 服务取得不透明凭证，在把完整有序内容列表交给 `ctx.attachments` 前解析每个属于同一 Agent 的凭证。`requestId` 已进入 queue 或日志时，prompt 重试直接返回原来的接受结果，不会重复插入消息。只有 create 与 fork 会直接创建新 Agent。该服务把同一套感知 preset 的恢复策略和 subagent ownership fence 同时用于自身方法，以及其他 Remote namespace 使用的 Typert Agent 与 Session lookup。Queue 变更只有一个狭窄例外：当前 projection identity 为 continuable 且来自自身非 seed suffix 的在线 child，可以在两个 inbox 目标上使用普通 Edit、Remove 与 QueueDock Steer action。One-shot、缺失、未知、损坏、仅含 seed identity 或冷 child 继续被拒绝，且不会恢复。skill 目录优先使用已有 live Agent，否则使用所记录 preset 的常驻 scope，因此列表查询绝不会启动 Agent。经过鉴权的文件交付路由通过 `workspaceDesktop()` 获取提供服务的 Host 名称和文件管理器行为。`openWorkspacePath({ path, action: "reveal" })` 将文件管理器导航委托给原生适配器；省略 `action` 时按文件类型关联打开，包括 HTML 和 SVG。两种操作都要求当前文件系统将请求的 Host 路径映射到同一个规范进程路径；无法映射的远端路径会在执行原生命令之前被拒绝。 `session.projections` 通过一次 live-preferred Session observation 读取完整基线，不激活 Agent。Session 不存在时返回 null，并可提供任意已注册的 projection key。Client 通过 `projectionsBySession` 暴露共享值和显式读取状态，由领域选择自身的 key。Session 列表摘要携带 `agentAvailable`，通过已有摘要与状态事件更新，与持久化 projection 相互独立。初始读取与实时 projection 帧使用相同的序号排序规则。

Client 列表行和驻留 Session 使用当前 `sessionListMetadata` 投影纠正过期的空白会话提示；最近活动时间取摘要时间戳与投影中最后一次用户提示词时间的较晚值。当 SessionManager 在列表行到达前创建实例时，会使用已保留的该 Session 元数据对账空白状态。因此，即使旧列表响应仍将已有对话标为空白，新会话操作也不会复用已经打开过的对话。

显式 ID 的 `session.create` 会收养活动 Session，或恢复持久化 Session 并持续持有其写锁。写锁争用返回 `session/writer-held`；调用方可以尝试其他空白会话，同时保留其他失败。`session.list` 根据缓存元数据列出持久化空白会话，不打开冷日志正文。

Client 列表刷新保留未变化的行对象，并在顺序和值均相同时复用条目数组。每行的 `retainedBy` 包含正数的本地引用来源计数，Host 元数据刷新不能覆盖它们。缓存成员检查使用每次刷新构建的 ID 集合，因此对账成本随当前列表和保留缓存的规模线性增长。 Host 摘要更新会替换运行状态与 Agent 可用性；本地 create/fork 响应只补充已有行缺失的元数据。普通 Session 被移除后，仅在目录仍有子项时保留其投影 store。

后台 job 的名册行与观测流属于 [`dsh-api-job-controller`](../job-controller/README.zh.md)；控制流只承载投影。

投影读取独立于其值保留加载与失败状态。重连会取消上一连接的读取，并重新加载已请求的投影；实时成员更新通过 control stream 到达。父 Agent 可用性来自 Host 摘要，在收到对应摘要或成功的列表 baseline 前保持未知。地址查找直接解析投影中的子项，不会选择它们或创建 scope。

已受理的提示词与已观察到的运行，会使客户端展示转换跨列表刷新、重连及 Session 对象替换保留。Manager 按 Session id 保留这些观察；它们不证明持久历史已经产生。草稿、投影存储和侧边栏展示规则保留原有行为。[blank 回退修复决策](../../../.agents/notes/implemented/bug-fix/2026-09-15-client-session-blank-reconciliation.zh.md) 定义保留期限及迟到响应处理。

Client 适配器提供 `SessionEventStream`，即绑定到一个普通 Session 或 direct subagent address 的 Gateway `RemoteJournalStream`。它在读取首个 page 前打开 follow，只发布连续的 `replace`、`prepend`、`append` 与 `settle-assistant` 变更，并通过 tail page 修复重连或 seq 缺口。向后分页有两个动词：`loadOlder()` 拉一页按轮次开头对齐的历史，而 `loadThrough(seq)`——轮次跳转加载器——按轮次开头对齐页面循环拉取直到窗口覆盖目标 seq，重复调用会下调共享目标，遇到无进展的页即停止，忙碌状态复用同一个 `loadingOlder` 快照位。Web 适配器显式选择接收无 cursor 的 Assistant frame：每个 opening 携带活跃 attempt 的 `startedAfterSeq`、`nextIndex` 与紧凑 stream，每个 stream member 都成为排在持久 cursor 之间的 Client-only `assistant/live-chunk` 条目。Host 会随该 baseline 捕获 follower 本地到达序号，并抑制该 cut 及之前的 buffered frame；replacement Agent 可以从 revision 一重新开始。活跃 opening 之后到达的持久 `assistant/message` 或 `assistant/attempt` 只有在其 seq 晚于 `startedAfterSeq` 且轮次与步骤匹配时才会保持暂存；匹配的 end type、seq 与 index 会发布持久条目。成功消息的瞬态 row 保留到所属 `step/end`，让待派发工具的身份持续可用；失败或中断的 settlement 立即移除对应 row，同一步骤中更早的 retry 仍然保留。已知 attempt 的 revision、密集 index 或 settlement 缺口会重新打开 follow；若 controller 错过 start，则忽略 unknown-attempt frame，并正常发布其持久 settlement。Abandoned end 会发布不含持久条目的 settlement delta，使瞬态 row 立即退出。持久缺口修复 page 不携带 Assistant baseline，因此 held notification 会重新打开 follow 一次，以取得配对的 page 与 baseline。每条历史 record 只覆盖自身的事件 seq。业务、persistence 或无法恢复的连续性错误会终止 stream，只有物理载体断开才触发自动恢复。`SessionControlStream` 是 Gateway `RemoteSnapshotStream`；每代都以完整的进程本地 baseline 开始，因此重连会替换 projection 状态，而不会把瞬态值当作 durable event。每次 Host generation 就绪时，同步的 Client 订阅会先清除保留的投影值及其水位，再刷新查询并重新打开 control stream，其中也包括 control baseline 中没有列出的 Session。首次 control stream 会等待 generation 就绪，确保其 opening 值不会先于旧状态清理到达。上一代尚未完成的 list 响应无法重新发布这些值。同一 generation 内，延迟到达的 control baseline 不能覆盖或清除较新的 sequenced 值，无论它们来自活 Session 的 list block、history page 还是 frame；冷 Session 从 projection cache 看出来的 cached list block 则不论水位都让位于建连 Session 的 baseline。持久 `inbox` 投影通过与其他投影相同的冷读取和重连路径传输两份待处理列表。Client Agent 上下文提供独立 [`fileUpload`](../../client/file-upload/README.zh.md) 服务使用的身份；Session 对象提供生命周期、prompt、queue 与历史操作，不提供文件传输。

Session 对象还承载本地提交回显：`session.beginSubmission` 在调用方序列化与提示词之前，同步把一条回显写入 `SessionSnapshot.pendingSubmissions`，会话 UI 因此能在点击提交的当帧显示消息。回显按顺序存放图片预览与持久文件引用。Session 根据当前运行状态与请求的投递模式推导其 `transcript`、`queued` 或 `steering` 位置，并保留该位置直到展示接管。提示词的 `requestId` 是关联标识：Host 把它回显为 durable user source 的 `rpcId`，`inbox` 投影中的待处理消息也保留同一 source。排队回显在队列接受后延迟一个动画帧退休；Chat 回显遵循下述入档规则。尚未入档的回显在带标识的提示词失败或被放弃时立即退休。销毁时保留已观察到的入档结果，其余未结算提交按 failed 退休。每次退休恰好触发一次 `onRetire`；observed 退休还会携带有序的持久附件引用，让 composer 释放成功卡片并保留失败草稿。回显只存在于 Client 内存；刷新与重连只从持久事件重建会话。


正常在线时，transcript 与 steering 回显在 Inbox 接受与领取期间留在 Chat，直到持久消息到达。本地 Chat 消息入档后，其身份保留到 Inbox 水位覆盖 next-turn 或 next-step 领取序号：Chat 已显示真实 Node，而 Chat 与 QueueDock 排除匹配的旧 Inbox 行。其他排队消息照常显示。新的 follow 基线会将已有接收回执的回显按 observed 撤去，使用已接受的附件引用完成结算；尚未确认接收的提交继续保留。待处理或已入档的消息随后由 Host 数据呈现。在领取与入档之间重连时，气泡可能短暂消失；撤去回显只确认接收，不代表执行或失败。

面向用户调用的 `skills/list` 元数据包含胜出提供方可选的指令文件 `path`。输入框可据此预览文件，无需加载每个 skill 的正文或激活冷态 Agent。

Fork 复制 `atSeq` 所选的精确事件前缀，包含切点事件，允许在开放轮次内截取。子会话在合成的 fork 结果和结束事件之前记录继承标记。省略 `atSeq` 时选择最近已结束轮次及其独立尾部，在下一轮次或排队输入之前停止；不存在的事件会被拒绝。聊天操作选择已结束轮次。

恢复会话时若已有写句柄占用，返回 `session/writer-held`，并携带会话 id；其他恢复失败仍返回 `gateway/internal`。

`loadThrough(seq)` 在共享目标被覆盖或加载结束前私下保留较早页面，随后把成功取得的页面按顺序作为一次前插发布。历史加载期间实时事件仍然可见。后续页面失败时保留已成功取得的部分；历史窗口被替换时丢弃被替换窗口的暂存页面。普通 `loadOlder()` 直接发布 Host 选取的一页结果。

Client 的首次 `follow`、重连首屏与 `loadOlder()` 至少请求 50 条以 append 方式追加的 `user/message` 和 `assistant/message` 事件，并向前跨过至少两个 `turn/start`，其中包含已加载窗口开头尚未补齐的轮次。Host 在首次同时满足两个下限的轮次开头停止；若先达到 500 条计数消息或历史已耗尽，则立即返回。Steering 不增加轮次分界。区间内的其他事件随页返回，但不计入消息预算。分页和 follow 请求可选的 `turnWindow` 在 `maxMessages` 上限内指定这两个下限。`loadThrough()` 复用相同规则，仅将每页消息数下限设为 200；500 条上限不限制整次跳转。不带 `turnWindow` 的请求保留按消息对齐的分页方式。

队列编辑仅允许用非空文本替换待处理内容。

附件授权读取内置 Session 事件声明的内容字段与已完成的 assistant 流块，包括扁平的 V4 tool 角色消息。未知事件载荷与无关字段不能授权附件读取。

本控制器通过 `ctx.plugin` 组合 `ArchivedSessionGate`：在 Agent 注册表、Session store 与 Workspace 注册表就绪后加载，随控制器一起释放。它的 `agent/pre-step` 监听器会拒绝为已归档会话或其子代理子孙——从 Session header 的血缘字段读出，从不包括 fork——提出的步骤，因此迟到的唤醒投递会让该回合以 `blocked` 收口而不发出模型请求；取消归档即为整条血缘解除门禁。已归档会话仍在跑的工作由各自的 owner 通过 Workspace 注册表的归档准入（[接缝](../../workspace/workspace/README.zh.md)）报告与停止：运行中的回合由 [Agent 注册表](../../core/agent/README.zh.md)负责，所属任务由[任务注册表接缝](../../jobs/jobs/README.zh.md)负责，子代理子孙由 [Subagent](../../subagent/subagent/README.zh.md) runtime 负责，提醒由 [Schedule](../../schedule/schedule/README.zh.md) 插件负责；本控制器自己不报告任何内容。

<a id="client-references"></a>
## Client 引用

`sessions.retain(target, { source, signal? })` 立即获取一个精确 Client generation 的引用，并启动其共享的首次历史打开。目标是已知 Session id 或持久的直接父子 subagent 地址；Host 在打开历史时校验显式地址。返回引用支持幂等的 `release()` 和 `Symbol.dispose`；其 `ready` Promise 跟随共享的 `Session.open()` 结果，并在该次尝试结算时解析为确切 binding，包括 Remote failure 以 `openState: 'error'` 表示的情况。仅当 `Session.open()` 拒绝、等待方取消或引用提前释放时，`ready` 才拒绝。取消一个等待方不会取消其他 owner 的打开。`sessions.using(target, options, operation)` 等待该次结算，持有引用直到回调结束，并传播被拒绝的就绪与回调失败。

引用保活本地会话数据、作用域 Context 和历史流，不保活 Host Agent。普通 Session 不因保留引用而添加目录行。已保留且具有明确直接父子地址的 subagent 即使尚未收到父目录，也会保留兜底行并通知列表读取方；这些行不加入 Host 列表成员集合。Fork 标题设置直接发送 rename 并应用返回的标题投影，不 retain 子会话，也不打开其历史。最后一个引用释放时，generation 先退出可访问映射，再执行清理；后续获取可以为同一 id 创建新 generation。`binding(id)` 和 `scope(id)` 只借用已有 generation。`retainInfo(id)` 独立于目录成员关系观察稳定的只读来源计数，不执行历史 I/O。消费方来源键可通过声明合并扩展；导航和完成确认属于 UI 消费方，不属于本控制器。所有权与清理规则见 [Client 会话引用](../../../.agents/notes/implemented/architecture/2026-09-15-client-session-references.zh.md)。 模式未知的子代理地址允许读取历史，但仍校验直接父级。成功恢复 descriptor 后确定展示模式；失败只影响该子会话，控制请求仍要求已确认的 continuable 身份。

<a id="session-media-references"></a>
## 会话媒体引用

当 `connection`、`fs` 与 `attachments` 均被组合时，`SessionMediaReferences` 在鉴权 `connection.fetch` 通道上挂载 `GET|HEAD /api/file?path=<绝对路径>`。它通过 `ctx.fs` 读取普通文件，包括已注册工作区之外的临时路径与远程提供方中的文件。目录包含关系与 MIME 类别均不限制访问；`mime-types` 提供响应类型，未知扩展名使用 `application/octet-stream`。GET 复用 `readBytes` 执行读取前及读取中的字节限制；HEAD 只读取元数据。所有文件均使用 `ctx.attachments.imageLimits.maxImageBytes`（通常为 20 MiB）；超过此上限返回 413。响应包含完整文件，忽略 Range，并携带 `private, no-store`、`nosniff` 与沙箱 CSP，使直接打开的 HTML/SVG 无法以 API 源身份执行脚本。客户端重写位于 `ui-chat`（`AssistantMarkdown`）；音视频文件响应已可用，Markdown 音视频播放器节点仍是独立工作。

GUI 模型选择要求确切提供方／模型对出现在可用目录中；不可用的选择以 `session/model-unavailable` 拒绝。提示词准入保留已保存的路由，不按目录可用性阻断发送，由请求执行报告凭据缺失或模型不可用。`initializeDefaultModel()` 在账号登录后、其他提供方均未配置 API key 时，将第一个可用账号模型保存为默认模型；凭据检查使用已配置的引用，不依赖模型是否可用。提供方没有可用模型时，初始化以 `session/provider-models-unavailable` 拒绝。可用性变化不会替换模型或改写会话选择。

`selectModel` 成功返回表示会话级模型选择已生效，不等待默认 profile 设置保存。默认设置在后台按提交顺序保存；保存失败会记录警告，并保留会话选择。新会话读取最近一次成功保存的默认值。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `nativeOpen` | 平台探测 | 是否能把 Session 工作区路径交给原生桌面打开器 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-session-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无；任何模型可见效果都由被调用的 Agent 命令负责。

#### KV Cache 影响

无直接影响；模型请求仍由 Agent 和 LLM（大语言模型）包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 图片字节上限不校验解码后的尺寸或像素数。
- follow 恢复失败会对调用方可见，而不会无限重试。
- 浏览器原始字节上传使用一次不带断点续传偏移的流式 HTTP 请求；重试会从第零字节重新传输整个文件。
- 文件引用补全使用共享 Agent lookup，因此可能恢复冷 Session；`skills/list` 目录是不激活 Agent 的 skill 元数据读取路径。
- 受理/运行的展示记忆只存在于客户端内存，页面重载后即丢失。
- 该记忆不在 tab 之间共享：同一会话可能在一个 tab 中已转正，在另一个 tab 中仍显示为 `New Session`。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每个分页与帧都会对照其指向的持久 Session 校验。
