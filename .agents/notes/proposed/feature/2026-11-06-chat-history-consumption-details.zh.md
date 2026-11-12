# Agent Note: Chat 历史消费的类与交互

Status: proposed

[English](2026-11-06-chat-history-consumption-details.md) | 中文

## Problem

历史页的网络生命周期属于 Session，能否安全进入当前页面属于 Chat。两阶段加载需要复用现有事件发布与滚动能力，不能把业务数据、消费意图和 DOM 保位状态复制到同一个所有者。

## Proposal

用户可见行为与取舍由[历史预取与安全消费](2026-11-06-chat-history-consumption.zh.md)定义。本文规定类之间的调用与生命周期，不增加独立的滚动动画或 React 提交管理。

### 所有者与接口

| 所有者 | 数据与操作 |
|---|---|
| [Session](../../../../packages/api/session-controller/src/client/sessions/session.ts) | `loadOlder({ deferConsumption?: boolean })` 准备并按选项消费一页；`consumeOlder()` 同步发布有效暂存页；`historyLoadStatus` 表达 idle/loading/pendingConsumption/error，`loadingOlder` 从 loading 派生并包含 Turn 跳转 |
| Session 请求记录 | 保存 generation、请求前游标、页内容、hasMore、Promise 与消费/失效标记；缓存页不提前改变可见窗口游标 |
| [ChatNavigation](../../../../packages/client/ui-chat/src/client/chat/use-chat-navigation.ts) | 保存 none/auto/manual 消费意图和请求互斥；自动按阻塞原因等待或退回按钮，手动采集锚点后消费，不注册阻塞结束等待 |
| [ChatViewport](../../../../packages/client/ui-chat/src/client/chat/use-chat-viewport.ts) | 读取内部输入/动画状态与 scrollTop，报告阻塞原因或 native/preserve/prepend；执行距离测量和已有锚点算法 |
| [useChatScroll](../../../../packages/client/ui-chat/src/client/chat/use-chat-scroll.ts) | 把既有阅读、滚动、内容及尺寸通知接到消费检查；在提交阶段结算待执行的一次补偿 |
| [ChatView](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) | 通过注入回调请求/消费，通过 useSession 读取状态；固定高度显示历史控件，不保存 Session 历史数据或累计 historyWasPartial |

```text
ChatNavigation.checkHistory
  ├─ pendingConsumption + intent=none → retain page until clicked
  ├─ pendingConsumption + intent=manual → beginManualPaging → consumeOlder
  ├─ pendingConsumption + intent=auto → viewport.historyConsumption
  │    ├─ touch/inner-scroll → retain automatic intent before checking motion
  │    ├─ motion/pointer/unavailable → return to button
  │    ├─ native → consumeOlder
  │    ├─ prepend → capture paging position → consumeOlder → correct once after commit
  │    └─ preserve → beginPreserving → consumeOlder
  ├─ loading → no duplicate request; a click records manual intent
  ├─ error → wait for explicit retry
  └─ idle + hasMore + (manual intent or near top without following) → request a page

Session.loadOlder
  → prepareOlder reuses or creates the request
  → await the captured request Promise
  → consumeOlder when request identity remains valid and consumption is not deferred

Session.prepareOlder
  → network prepend → capture the page without publishing eventSource
  → validate progress → pendingConsumption or error

Session.consumeOlder
  → check generation/cursor/consuming
  → synchronous eventSource.prepend → existing Conversation merge and flush
  → clear the request record and publish final status
```

### 数据生命周期

`isOpen` 只表达会话 `openState === 'open'`，与某页是否 `pendingConsumption` 无关。`historyWasPartial` 是客户端 Session 实例的单调事实：可见窗口曾有 `hasMore=true` 后保留到实例结束，不随组件重挂载或重连清除，不写持久化日志。

`prepareOlder()` 返回已有请求或创建一个请求，`loadOlder()` 等待捕获的请求 Promise 后再核对身份。旧 Promise 完成不能消费随后创建的新页。默认调用消费准备好的页；`deferConsumption` 保留有效非空页，终态空页可以直接确认耗尽。消费期间保持请求记录并设置 `consuming`，阻止同步订阅者重入，不借用网络 loading 状态。

普通请求先捕获传输返回页，只有请求成功且游标前进，或空页明确表示耗尽时才能消费。失败或空页仍声称有更多则进入 error，不自动重试。窗口替换、重连和销毁使旧页失效；如果在途请求可能已推进传输游标，现有流重启先恢复基线，再允许下一页。

`loadThrough(seq)` 是显式导航：先采用已有待消费页，再沿既有 Turn 对齐规则加载；普通请求在途时保持互斥，由调用方在其结算后继续。跳转的成功前缀在完成或后续失败时一次发布，实时追加不等待它。`loadingOlder` 始终等价于 `historyLoadStatus === 'loading'`。

### 消费意图与唤醒

自动请求开始时登记 auto，点击登记 manual。消费成功、失败、耗尽或取消导航时清除意图。缓存存在但意图为 none 时，普通事件不测量或消费该缓存；按钮重新登记 manual，不重复取页。touch 与实际 inner-scroll 优先于 motion 判断保留 auto，释放后重新检查当前状态；其余 motion、pointer 或 unavailable 使 auto 退回 none。manual 在页面可用时绕过这些自动阻塞：`beginManualPaging()` 在 `scrollTop ≤ 0.5` 时调用 `beginPaging()`；其他位置调用 `beginPreserving()`，并以 `beginPaging()` 兜底。没有产生锚点时仍继续消费。加载和处理状态的点击加入当前请求，不重复请求。

历史预取复用已有 500ms 阅读采样、scrollend、内容提交和尺寸通知，并合并为一次 rAF 检查。不使用 IntersectionObserver，不新增采样计时器，不在原始 scroll 事件中测量。仅 scroller 自身的 ResizeObserver 条目在回调读阶段更新 clientHeight 缓存，column 增长不重新读取视口高度。内部状态允许自动请求时，读取历史控件相对视口的位置，与缓存的两屏高度比较。

`historyConsumption()` 不查询 DOM 或测量尺寸。`FlowMotion.active()` 从已有 running、batchScheduled、batch、settling 状态提供只读查询；输入状态来自被动事件监听。滚动目标失效的清理在尺寸观察处进行。手指释放、内层滚动结束、过渡结束/取消和既有通知可以唤醒保留的自动意图；手动消费不注册折叠结束等待。没有消费意图时这些通知不恢复已经放弃的自动页。

### 锚点复用与布局读取

自动消费在顶部 `scrollTop ≤ 0.5` 时使用 `beginPaging` 的首条分页锚点规则，不先执行阅读位置命中检测。`measurePaging()` 只采集 `PagingPosition`；`retainPaging()` 单独拥有持续保位和内层尺寸观察。普通静止保位与一次补偿共用 `resolvePaging()` 的重挂载查找及 `applyPaging()` 的内外层计算。

持续保位和一次补偿用相同的 `applyPaging()` 公式恢复采集时的屏幕位置，先补内层、再补外层。计算不叠加采集后 scrollTop 的变化，因为这些变化可能已经来自原生锚定。两者只区分生命周期：一次补偿不进入 paging 状态、不注册内层尺寸观察，应用一次后释放。`finishHistoryPrepend()` 返回实际落点，提交处理立即通过 `reading.preservePosition()` 保存阅读位置，不依赖后续 scroll 事件。已提交的 `pendingConsumption` 到 `idle` 状态转换，即使可见 Node 顺序未变化，也会结算一次补偿记录；视图关闭或进入 `error` 时丢弃记录，不应用补偿。几何失效仍只由已有布局变化信号触发，不增加页 token 或 React 发布机制。会话实际滚动容器设置 `overscroll-behavior-y: none`，不创建平滑滚动或新的惯性动画。

距离检查仍需要当前几何；前插后的一次补偿仍需要读取新位置。这些读数有正确性用途，但不能仅凭位于 rAF、ResizeObserver 或提交回调中，就认定不会增加布局。读取频率、读写顺序及实际 Layout/Paint 成本分别验收；位置不漂移不能替代性能证明。

## Alternatives considered

**在 Conversation 全局暂停发布。** 会同时阻止尾部实时输出，扩大跨视图影响。

**在 Chat 保存完整窗口快照。** 复制业务数据，消费时可能覆盖等待期间的新消息。

**为一次补偿另存坐标并持续追踪首行。** 与既有分页锚点重复，并可能扩大滚动控制；共享位置记录和计算，只区分生命周期。

**通过 `preserveMovement` 叠加采集后滚动增量。** 该增量无法区分读者输入与同一次前插的原生锚定，叠加后可能重复补偿。

## Acceptance criteria

- 默认单阶段调用、延迟消费及 Turn 跳转共存，旧请求不能消费或覆盖新请求。
- auto 回退不会被普通事件恢复；触摸与内层滚动续接、manual 完成承诺和卸载清理都有定向验证。
- 一次补偿使用既有屏幕位置恢复公式，不注册持续观察、不重复原生补偿；持续保位和内层补偿不退化。
- 距离读取使用缓存视口高度；原始滚动监听与消费准入不读取布局。

## Risks

屏幕位置恢复使用原生锚定后测得的剩余位移，而不是叠加滚动位置增量。它不保留采集到应用之间任意输入造成的移动，也不保证惯性轨迹连续。外层近零位置、内层原生锚定以及前插附近到达的输入，都需要当前构建的浏览器验证。

显式导航与多个视图共享 Session，不能把 Chat 的自动等待条件放进全局事件源。手动消费在消费时建立持续保位；已经进行的触摸随后可能进入 paging 滚动分支而非读者采样，移动受限直到新输入释放锚点。这项[手动分页限制](../../../../packages/client/ui-chat/README.zh.md#known-limitations-and-deferred-work)仍未解决。手动消费在无法采集锚点时仍继续，因此该结构不保证位置稳定。取消、重连和所选锚点被移除属于不同生命周期情况；锚点缺失时无法提供位置保留。一次补偿的布局测量、内层浏览器锚定及异步内容增长需要当前构建的浏览器证据。

验收报告应列明源码/产物版本、真实或合成输入、未覆盖条件以及清理结果。V8 函数或区间命中不等于 TypeScript 行/分支百分比；早期迭代的录像、Chrome/Safari 手工体验和单个构建通过不能证明本提案的完整矩阵已通过。
