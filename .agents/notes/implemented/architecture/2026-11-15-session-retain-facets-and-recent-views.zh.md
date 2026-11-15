# Agent Note: Session retain 子要素与最近访问会话

Status: implemented

[English](2026-11-15-session-retain-facets-and-recent-views.md) | 中文

## 问题

Web Client 的主视图切走一个 Session 时，会释放该 Session 的 `mainView` 引用。引用计数归零后，Client 销毁该 Session 的 binding、事件窗口和 Conversation 折叠状态，切回时只能重新拉取历史。

保住 Session 本身代价不高：事件窗口只追加，数据流复用同一条 Gateway WebSocket，Host 侧订阅是被动的。真正的开销在派生计算。[`BoundConversation`](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) 在构造时就订阅事件窗口，此后不论 Session 是否被渲染，每个事件（包括每个 `assistant/live-chunk`）都要经过 Definition 的 `match`/`update` 折叠，并按 rAF 合批发布。被保住的后台 Session 只要仍在运行，就会一直付出这笔计算。

retain 接口只能表达保住或释放整个 Session，无法表达「只收数据，不做派生计算」。

## 决策

本决策扩展 [Client Session 引用](2026-09-15-client-session-references.zh.md)，但不取代它：引用、来源计数和 `ready` 语义不变，`SessionRetainOptions` 携带子要素。

### Session retain 与子要素

Session retain 始终保活 binding、作用域、历史连接和事件窗口。连接是强制的，不作为子要素。

子要素（facet）是在此基础上另外保留的部分，每个子要素单独计数。引用在创建时通过 options 声明要保留哪些子要素：

```ts ignore-check
// session-controller/client: declares no facets
export interface SessionRetainFacetMap {}
export type SessionRetainFacet = Extract<keyof SessionRetainFacetMap, string>

export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  /** Parts kept alive beyond the Session's history stream; an absent key is not retained. */
  readonly facets?: Readonly<Partial<Record<SessionRetainFacet, boolean>>>
  readonly signal?: AbortSignal | undefined
}

export interface SessionBinding {
  // existing members unchanged
  /** Whether any live reference retains `facet`; identity-stable per binding and facet. */
  facet(facet: SessionRetainFacet): ObservableSnapshot<boolean>
}
```

| 规则 | 行为 |
|---|---|
| 声明方式 | 子要素由其 owner 包通过声明合并加入 `SessionRetainFacetMap`；Controller 不赋予任何子要素含义 |
| 缺省 | 未写的键不保留；子要素没有默认值 |
| 不可变 | 一条引用的子要素集合在创建时固定；更换集合时先 retain 新引用，再 release 旧引用 |
| 计数 | [`RetainedFacets`](../../../../packages/api/session-controller/src/client/sessions/facets.ts) 为每个 generation 的每个子要素各记一个计数；计数在零与非零之间变化时同步通知 `binding.facet(name)` 的观察者，早于 `retainInfo` 与列表观察者收到同一变化；generation 退役时结束全部子要素 |
| 依赖 | Controller 不校验子要素之间的依赖，由调用方负责 |
| `using()` | 签名不变；借出的引用只服务一次操作，调用方不写 `facets` |
| `retainAgentScope` | 不保留任何子要素 |

### `conversation` 子要素

`ui-conversation` 声明 `conversation`：对事件窗口做 Conversation 折叠并物化其视图。

- `BoundConversation` 仍然每个 binding 一个，其 `snapshot`、`openTurn` 和 `target(t)` 数据源保持对象标识稳定。`UiConversation.binding()` 先在 Session 作用域上登记该绑定的清理，再让绑定开始跟随；首次折叠失败时清理该绑定，下次解析重新开始。
- 子要素**开始**被保留时，绑定先订阅事件窗口，再一步完成恢复：首次折叠或未跟随期间发生的注册表变化会按当前窗口整窗重建一次；否则期间收到的连续变化走增量 assembler，revision 出现缺口时整窗重建。随后取消待发的 rAF 并同步发布一次，这次折叠失败时也是如此。未跟随期间激活的视图基于上一次折叠结果建立，并在恢复时补齐。
- 子要素**停止**被保留时，绑定退订事件窗口并取消待发的 rAF。最后一次发布的快照仍可读取，但不再更新。切换过程中旧 DOM 尚未卸载时，其组件读到的就是这份快照。正在进行的事件分发会检查绑定是否仍在跟随，因此分发中途的释放会立即停止折叠。
- 子要素未被保留时调用 `uiConversation.binding()`，得到的是未被保留的绑定，读取上一次或空的快照，不会抛错。
- 跟随 `conversation` 子要素的计算有两项：`BoundConversation` 与 [ui-chat](../../../../packages/client/ui-chat/src/client/apply.ts) 的 quota 监听；后者对子要素未被保留期间收到的失败既不发布也不补发提示。`binding.ctx` 上其他不由事件驱动的状态（输入 shell、命令弹层、历史图片 URL、agent preset seat）保持原有生命周期。

### 引用来源与子要素

| 来源 | 所属包 | `facets` |
|---|---|---|
| `mainView` | ui-session 声明，ui-workspace 调用 | `{ conversation: true }` |
| `sidebarView` | ui-sidebar-right | `{ conversation: true }` |
| `sidebarChat` | ui-subagent | `{ conversation: true }` |
| `recentViews` | ui-workspace | 不写 |
| `using()` 调用方与 `gateway` | 各自的包 | 不写 |
| 测试替身默认值 | test-support/client-runtime | `{ source: 'testFixture', facets: { conversation: true } }` |

### 最近访问会话 `recentViews`

ui-workspace 的 [navigation](../../../../packages/client/ui-workspace/src/client/navigation.ts) 持有一个 [`RecentSessionViews`](../../../../packages/client/ui-workspace/src/client/recent-views.ts) 列表，每一项持有一条 `recentViews` 引用。

| 规则 | 行为 |
|---|---|
| 顺序 | 新的 `mainView` 引用就绪后，导航先释放新主 Session 的最近访问项，再把上一个主 Session 保留为最近访问会话，最后释放上一个 `mainView` 引用；上一个 Session 的引用计数不会归零，重复选中当前 Session 时列表保持不变 |
| 入队 | 离开时先 retain 新的 `recentViews` 引用，再释放同一 Session 的旧项，并插入 retain 返回时的当前列表，因为 retain 会同步发布 Session 列表，期间可能触发对账或释放本列表 |
| 空白 | 离开时仍是空白的 Session 不入队 |
| 失败 | retain 失败时报告到控制台，该 Session 按没有最近访问时的方式释放，导航继续 |
| 出队 | Session 或 Workspace 列表变化时，被移除或归档的 Session 出队 |
| 关注 | 统一 Session UI 状态显示为运行中、等待用户或完成未读的 Session 既不计数也不淘汰；读过且空闲后重新计数 |
| 上限 | 计数的 Session 最多 10 个，不含当前 Session；用模块常量加 `TODO` 写死，等 Client 支持配置后再改 |
| 淘汰 | 超出上限时先淘汰最早离开的未置顶 Session，再淘汰最早离开的置顶 Session；Session 列表、Workspace 列表或 Session UI 状态变化时都会重新检查 |
| 卸载 | 插件卸载时退订两个列表与状态，并释放全部引用 |

## 备选方案

**按订阅数决定是否跟随。** `BoundConversation` 只在有订阅时折叠，冷态读取时同步补齐。React 先渲染后订阅，跟随要靠读取时补齐来避免首帧陈旧，而且是否计算取决于偶然的订阅时序，而不是持有方的意图。

**把引用来源分成 render 与 hold 两类。** 这只能表达一个开关；草稿这类独立计数的部分还需要另一种分类。

**由子要素 owner 在运行时声明默认值。** 这需要 Controller 维护运行时注册表，并在加载顺序与 HMR 下重新计数；而「未写即不保留」的规则已经足够。

**把 `events` 也作为子要素。** 没有连接的 Session 什么也做不了；唯一不需要连接的 Gateway 已经有独立的内部入口。

**保留后台 Session 的 DOM。** React 18 没有 `<Activity>`；K 个隐藏子树要付出布局、内存和订阅成本，还与 `session-maybe` 只绑定一个 Session 的设计冲突。

**未被保留时继续折叠，只推迟发布。** 流式块的 `match`/`update` 成本仍然存在。

**自行计算已折叠输入与窗口之间的差集。** 未被保留期间，一次 attempt 可能从开始、流式到 settle 全部完成，这类差集逻辑容易出错；恢复改为复用 assembler 现有的连续变化路径与缺口重建路径。

## 后果

- 后台 Session 切回时无需历史请求，而在再次显示之前不做任何 Conversation 折叠。
- 未被保留的 Session 保留其最后一次折叠的内存，直到再次显示或其 binding 退役。
- 切回在后台运行过的 Session 要付出一次补折，最多等同于新打开时的一次打开后折叠，但不走网络。
- 漏写 `conversation: true` 的渲染方会看到未被保留的陈旧或空快照，不会报错。
- `SessionRetainOptions` 与 `SessionBinding` 是 pre-stable 公开接口；所有消费方和测试替身已一同修改。

## 测试

- [reference-ownership.client.spec.ts](../../../../packages/api/session-controller/tests/reference-ownership.client.spec.ts) 覆盖按子要素计数、只在零值变化时通知，以及子要素随 generation 退役与根释放结束。
- [conversation-registry.client.spec.ts](../../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts) 覆盖未被保留时零折叠、恢复时同步发布一次、与持续跟随结果一致、未跟随期间的激活与注册表变化、分发中途的释放、被打断的 rAF 发布、恢复失败，以及首次折叠失败不残留订阅。
- [quota-notice.client.spec.tsx](../../../../packages/client/ui-chat/tests/quota-notice.client.spec.tsx) 覆盖 quota 提示只在子要素被保留时发布。
- [recent-views.client.spec.ts](../../../../packages/client/ui-workspace/tests/recent-views.client.spec.ts) 与 [workspaces-service.client.spec.ts](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) 覆盖关注与置顶规则、retain 期间的同步重入、达到上限时的导航顺序、由列表变化驱动的对账，以及经由同一 generation 切回最近访问会话且不重新打开历史。
