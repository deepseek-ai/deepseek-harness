# Agent Note: Session retain 子要素与最近访问会话

Status: implemented

[English](2026-11-15-session-retain-facets-and-recent-views.md) | 中文

## 问题

Web Client 的主视图切走一个 Session 时，会释放该 Session 的 `mainView` 引用。引用计数归零后，Client 销毁该 Session 的 binding、事件窗口和 Conversation 折叠状态，切回时只能重新拉取历史。

保住 Session 本身代价不高：事件窗口只追加，数据流复用同一条 Gateway WebSocket，Host 侧订阅是被动的。真正的开销在派生计算。[`BoundConversation`](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) 在构造时就订阅事件窗口，此后不论 Session 是否被渲染，每个事件（包括每个 `assistant/live-chunk`）都要经过 Definition 的 `match`/`update` 折叠，并按 rAF 合批发布。被保住的后台 Session 只要仍在运行，就会一直付出这笔计算。

retain 接口只能表达保住或释放整个 Session，无法表达「只收数据，不做派生计算」。

## 决策

本决策扩展 [Client Session 引用](2026-09-15-client-session-references.zh.md)，但不取代它：引用与来源计数不变；`SessionRetainOptions` 携带 `connection` 与子要素，不保留连接的引用在 binding 建好时即就绪。它以 `draft` 引用取代 [跨会话切换保留草稿附件](../bug-fix/2026-11-13-draft-attachments-across-session-switches.zh.md) 中的草稿附件归属机制。

### 连接与子要素

Session 引用始终保活 Session 对象及其作用域，作用域上保存草稿、发送回显等本地状态。两个选项决定在此之外还保留什么：

```ts ignore-check
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  /** Keeps the Session's own event connection and the event window it keeps current; defaults to `true`. */
  readonly connection?: boolean
  /** Owner-declared facets this reference keeps computing over the Session's data; an absent key is not computed. */
  readonly facets?: Readonly<Partial<Record<SessionRetainFacet, true>>>
  readonly signal?: AbortSignal | undefined
}

export interface SessionRetainInfo {
  // existing members unchanged
  /** Positive counts of references retaining each facet; absent while no reference retains any facet. */
  readonly retainedFacets?: Readonly<Partial<Record<SessionRetainFacet, number>>>
  /** Positive count of references keeping the event connection; absent while none does. */
  readonly connectionCount?: number
}
```

| 规则 | 行为 |
|---|---|
| 连接 | 连接指 Session 自己的 follow 流及其维持最新的事件窗口，不是页面传输连接。第一个保留连接的引用出现时建立；作用域仍在而最后一个保留连接的引用被释放时，`Session.disconnect()` 关闭连接、清空窗口，并让 Session 回到 cold 状态，发送回显保留；下一个保留连接的引用按首次打开的流程重新连接 |
| 子要素 | owner 包通过声明合并把子要素加入 `SessionRetainFacetMap`；Controller 不赋予任何子要素含义。未写的键不计算；子要素基于连接保有的数据计算，没有数据就无从计算 |
| 缓冲的更早页 | 连接仍在而最后一个子要素被释放时，`Session.bufferOlder()` 只让按 Turn 对齐的最后一页可见，并把更早的条目交给它的 `SessionEventStream`。Session 的翻页逻辑不变；stream 读页时先按请求的 Turn 窗口从这些缓冲记录中切一页返回，不发请求，用完后再读 Host 分页。窗口被整体替换时丢弃缓冲，resync、断开或销毁时随 stream 一起丢弃。[`buffered-pages.ts`](../../../../packages/api/session-controller/src/client/sessions/buffered-pages.ts) 负责分页切点 |
| 计数 | [`shiftFacetCounts`](../../../../packages/api/session-controller/src/client/sessions/facets.ts) 在 generation 的 `SessionRetainInfo` 中为每个子要素记一个计数，与 `connectionCount` 和按来源的 `retainedBy` 并列；`retainInfo(id)` 发布每次变化，owner 根据该快照与当前 binding 推导自己的子要素，因此 `SessionBinding` 不变 |
| 不可变 | 一条引用的选项在创建时固定；更改时先 retain 新引用，再 release 旧引用 |
| `using()` | 签名不变；借出的引用默认保留连接，不请求子要素 |
| `retainAgentScope` | 既不保留连接，也不保留子要素 |

### `conversation` 子要素

`ui-conversation` 声明 `conversation`：对事件窗口做 Conversation 折叠并物化其视图。

- `BoundConversation` 仍然每个 binding 一个，其 `snapshot`、`openTurn` 和 `target(t)` 数据源保持对象标识稳定。`UiConversation.binding()` 先在 Session 作用域上登记该绑定的清理，再让绑定开始跟随；首次折叠失败时清理该绑定，下次解析重新开始。
- 子要素被保留期间，绑定对当前整个窗口折叠一次、同步发布，并跟随窗口变化；折叠失败时绑定保持未折叠，下一次窗口变化重新整窗折叠。
- 子要素被释放时，绑定退订、取消待发的 rAF、丢弃折叠结果，并发布一次空结果；释放期间的注册表变化要等再次保留时才生效。正在进行的事件分发会检查绑定是否仍在跟随，因此分发中途的释放会立即停止折叠。
- 跟随 `conversation` 子要素的计算有两项：`BoundConversation` 与 [ui-chat](../../../../packages/client/ui-chat/src/client/apply.ts) 的 quota 监听；后者对子要素未被保留期间收到的失败既不发布也不补发提示。

### `draft` 引用

[输入 hub](../../../../packages/client/ui-conversation/src/client/input/hub.ts) 在某个 Session 的输入框草稿有附件且该 Session 未被移除时，以 `{ source: 'draft', connection: false }` 持有它。因此所有视图都释放该 Session 后，作用域以及同一个输入框 shell 和其中的浏览器侧附件仍然保留；切回时重新连接并重新折叠，输入框保留附件、上传进度和失败上传的重试。移除最后一个附件、发送它或移除 Session 会释放这条引用，随后作用域销毁时释放全部草稿附件。页面卸载时仍为草稿有附件的 Session 写标记，下一个页面提示这些附件已失效。

### 引用来源与子要素

| 来源 | 所属包 | 选项 |
|---|---|---|
| `mainView` | ui-session 声明，ui-workspace 调用 | `{ conversation: true }` |
| `sidebarView` | ui-sidebar-right | `{ conversation: true }` |
| `sidebarChat` | ui-subagent | `{ conversation: true }` |
| `recentViews` | ui-workspace | 不写：只保连接 |
| `draft` | ui-conversation | `{ connection: false }` |
| `using()` 调用方 | 各自的包 | 不写 |
| `gateway` | session-controller | 不保留连接的内部入口 |
| 测试替身默认值 | test-support/client-runtime | `{ source: 'testFixture', facets: { conversation: true } }` |

### 最近访问会话 `recentViews`

ui-workspace 的 [navigation](../../../../packages/client/ui-workspace/src/client/navigation.ts) 持有一个 [`RecentSessionViews`](../../../../packages/client/ui-workspace/src/client/recent-views.ts)，为每个最近访问会话持有一条 `recentViews` 引用。

它的状态只记录用户做过什么：Session 离开主视图的顺序，以及主视图当前显示的 Session。一个幂等的 `sync()` 根据这些状态和当前的 Session 列表、Workspace 列表与 Session UI 状态算出应持有的 Session，先 retain 缺少的，再释放其余的。导航在 retain 新的 `mainView` 引用之后、释放上一个之前调用 `show(sessionId)`；Session 列表、Workspace 列表和状态变化时调用 `sync()`。retain 会同步发布 Session 列表，因此重入的 `sync()` 只标记状态已变化，正在执行的一轮会重复，直到选择稳定。

| 规则 | 行为 |
|---|---|
| 顺序 | `show()` 同步时两个 `mainView` 引用都还在，因此上一个 Session 先成为最近访问会话、再释放其 `mainView` 引用，引用计数不会归零；主视图 Session 永远不是最近访问会话，重复选中它时选择保持不变 |
| 空白 | 离开时仍是空白的 Session 不入队 |
| 失败 | retain 失败时报告到控制台一次，该 Session 离开顺序列表，随其 `mainView` 引用一起释放；导航继续 |
| 出队 | 被移除、归档或淘汰的 Session 离开顺序列表，只有主视图再次离开它时才会回来 |
| 关注 | 统一 Session UI 状态显示为运行中、等待用户或完成未读的 Session 既不计数也不淘汰；读过且空闲后重新计数 |
| 上限 | 由 ui-workspace 配置 `recentViewLimit` 决定，默认 10，计数的 Session 不含主视图 Session；它是 Host `Config` 的 volatile 字段，浏览器经[前端插件配置同步](2026-11-15-client-config-sync.zh.md)接收，修改后无需刷新即生效，已淘汰的 Session 不会回来 |
| 淘汰 | 超出上限时先淘汰最早离开的未置顶 Session，再淘汰最早离开的置顶 Session；Session 列表、Workspace 列表或 Session UI 状态变化时都会重新检查 |
| 卸载 | 插件卸载时退订两个列表与状态，清空顺序列表，并释放全部引用 |

## 备选方案

**按订阅数决定是否跟随。** `BoundConversation` 只在有订阅时折叠，冷态读取时同步补齐。React 先渲染后订阅，跟随要靠读取时补齐来避免首帧陈旧，而且是否计算取决于偶然的订阅时序，而不是持有方的意图。

**把引用来源分成 render 与 hold 两类。** 这只能表达一个开关；草稿这类独立计数的部分还需要另一种分类。

**由子要素 owner 在运行时声明默认值。** 这需要 Controller 维护运行时注册表，并在加载顺序与 HMR 下重新计数；而「未写即不保留」的规则已经足够。

**在 `SessionBinding` 上暴露子要素 observable。** `SessionBinding` 新增必需成员会让所有手写 binding（包括第三方测试替身）失效，而子要素计数本就是本地引用计数，`retainInfo` 已在按来源计数旁发布它们。

**用固定级别代替子要素。** 固定的 `state`、`cache`、`live` 枚举无法随后续 owner 诉求扩展，而默认开启的 `connection` 加上 owner 子要素就能表达这三种状态。

**释放子要素后保留最后一次折叠结果。** 无主的陈旧结果会多出一个隐含状态；窗口仍在，切回时只折叠最后一页的代价很小。

**在根级维护草稿附件归属。** 在 Conversation 服务中记录归属并在新输入框中重新接回，等于用会话目录监听重复跟踪 Session 生命周期；保住作用域就能保住输入框本身。

**保留后台 Session 的 DOM。** React 18 没有 `<Activity>`；K 个隐藏子树要付出布局、内存和订阅成本，还与 `session-maybe` 只绑定一个 Session 的设计冲突。

**未被保留时继续折叠，只推迟发布。** 流式块的 `match`/`update` 成本仍然存在。

**自行计算已折叠输入与窗口之间的差集。** 未被保留期间，一次 attempt 可能从开始、流式到 settle 全部完成，这类差集逻辑容易出错；切回时改为从头折叠最后一页。

## 后果

- 最近访问会话切回时无需历史请求，只折叠最后一页；往上翻阅已加载的页不发请求。
- 最近访问会话在内存中保留其完整的已加载窗口，但不保留 Conversation 折叠结果。
- 带草稿附件被淘汰出最近访问会话的 Session 保留输入框，但不保留窗口，切回时要重新请求历史。
- 受关注保护的最近访问会话没有总量上限：完成未读会一直受保护直到用户读过，因此用户不在时每个以未读状态完成的 Session 都会保留其 generation、已加载的事件窗口和历史跟随流，直到被读过、标为已读、被移除或归档。
- 漏写 `conversation: true` 的渲染方会看到未被保留的陈旧或空快照，不会报错。
- `SessionRetainOptions` 与 `SessionRetainInfo` 只新增可选字段；以自己的来源 retain 并渲染 Session 的第三方 Client 插件需加上 `facets: { conversation: true }`，只需本地状态的插件可写 `connection: false`，见[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.3/session-retain-conversation-facet/guide.zh.md)。

## 测试

- [reference-ownership.client.spec.ts](../../../../packages/api/session-controller/tests/reference-ownership.client.spec.ts) 覆盖按子要素与连接计数、不建立连接地持有 Session、最后一个保留连接的引用释放后断开、最后一个子要素释放后缓冲更早页，以及计数随 generation 退役与根释放结束；[session.client.spec.ts](../../../../packages/api/session-controller/tests/session.client.spec.ts) 覆盖缓冲页翻页、Turn 跳转、缓冲页用完后的 Host 分页、实时增长后再次缓冲，以及断开后重新连接。
- [conversation-registry.client.spec.ts](../../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts) 覆盖释放时丢弃折叠、保留时同步折叠一次、与持续跟随结果一致、未跟随期间的激活与注册表变化、分发中途的释放、被取消的 rAF 发布、折叠失败，以及首次折叠失败不残留订阅；[draft-attachment-retention.client.spec.ts](../../../../packages/client/ui-conversation/tests/draft-attachment-retention.client.spec.ts) 覆盖 `draft` 引用、其释放、被移除的 Session 与卸载标记。
- [quota-notice.client.spec.tsx](../../../../packages/client/ui-chat/tests/quota-notice.client.spec.tsx) 覆盖 quota 提示只在子要素被保留时发布。
- [recent-views.client.spec.ts](../../../../packages/client/ui-workspace/tests/recent-views.client.spec.ts) 与 [workspaces-service.client.spec.ts](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) 覆盖关注与置顶规则、retain 期间的同步重入、主视图 Session 不计数、淘汰后不自动回来、配置、由列表变化驱动的对账，以及经由同一 generation 切回最近访问会话且不重新打开历史。
