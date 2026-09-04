# Agent Note: 推理（reasoning）分片的逐帧累计发布与浏览器压力验证

Status: implemented

[English](2026-08-03-opt-in-reasoning-chunk-browser-stress.md) | 中文

## 问题

长 reasoning stream 会在一个持久 settlement 前连续产生大量进程本地 `assistant/live-chunk` update。每个 update 都必须保持有序并折叠进 Assistant Definition，以保留实时完整性；settlement 则嵌入精确 stream 供 replay。React 只需要看到当前累计结果，不需要观察同一浏览器帧内每个中间态。

异步流的每次 `yield` 都可能形成新的微任务边界，因此仅靠微任务合批的 `Notifier.markDirty()` 会退化为每个分片重建一次 `ConversationSnapshot`、通知一次 `useSyncExternalStore` 并运行一次 React render。即使实时 Think 行保持折叠，100,000 个推理分片仍会让协调、提交和布局工作压住主线程。性能边界必须位于会话接收与 React 发布之间，不能通过减慢生产方或丢弃原始事件来掩盖问题。

## 决策

Session Controller 把每个 Client-only live chunk 追加到 event source，Conversation 会立即把它折叠进每个匹配 Definition State。Chat 与 Trajectory Definition 为可见 `block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta` 与 `block-end` chunk 请求 `animation-frame` publication；第一项变化调度一次 `requestAnimationFrame`，后续 chunk 继续更新 State，frame callback 再从最新 State materialize 一个累计 snapshot。`usage` 与 `finish` 不请求 publication。持久 `assistant/message` 或 `assistant/attempt` settlement 会立即发布，并在历史 replay 中复现同一最终 stream。

`BoundConversation` 为每个 Session 拥有一个 pending frame。普通结构 event 与持久 settlement 请求 immediate publication，flush 最新 assembled State，并让之后的 frame callback 因没有 dirty Context 而不产生影响。没有 `requestAnimationFrame` 的环境会立即发布。Settlement 可以跳过一个尚未显示的中间 partial，但发布的最终 content 与持久嵌入式 stream 保持完整。

实时 Think 行对累计文本的横向跟尾属于纯视觉对齐，不需要在每次 React 提交中同步读取布局。组件内调度器将连续请求合并为每三帧一次，从最新 DOM 读取 `scrollWidth` 和 `clientWidth` 并将 `scrollLeft` 直接更新到最新位置；固定的视觉节奏让摘要变化可读，又不会积压浏览器平滑滚动动画。该节流只作用于 Think 的横向摘要，不延迟 Chat 正文滚动、历史 prepend 锚定或用户触发的 `scrollIntoView`。

`pnpm run test:web:stress` 保留为无密钥、需显式启用的浏览器性能证据。确定性的 `?fixture` 会话以独立于绘制的节奏发出 100,000 个 `reasoning-delta`，结尾标记证明事件经过生产会话归并并到达实时 Think 行；50 毫秒心跳和预先调度的 DOM 事件分别测量主线程停顿与交互延迟，250 毫秒预算用于识别明显回归。`DSH_WEB_STRESS_HEADFUL=1` 允许开发者在可见浏览器中使用 Performance 面板分析同一场景。该压力车道是手动性能诊断与修复验收的证据，不是默认 CI 门禁，也不替代确定性的调度单元测试。

聚焦测试固定 `Notifier` 的逐帧合并、结构事件抢占、失效回调和无 rAF 回退，并在 `Session` 层证明一帧只发布一次最新累计文本且定稿不会被旧帧回调重复通知。fixture（测试前置数据）的小型单元测试继续固定输入校验、外部到达节奏、并发拒绝、精确事件数和结尾标记交付，无需把 100,000 分片工作负载带入默认测试套件。

## 曾考虑的替代方案

**在 React 内对快照使用 transition、deferred value 或组件节流。** 不予采纳：会话源仍会逐分片通知 `useSyncExternalStore`，React render 在组件决定延后展示之前已经发生，且多个消费同一快照的组件需要重复实现策略。Think 摘要的视觉跟尾节流位于快照发布之后，只减少同步布局频率，不承担数据发布策略。

**在 Definition fold 前丢弃或抽样 live chunk。** 不予采纳：实时累计 State 会与持久嵌入式 stream 分歧，并可能省略可见中间内容。紧凑持久存储与逐 frame 合并 React publication 解决的是不同成本。

**只使用微任务合批。** 不予采纳：连续异步 `yield` 会在相邻分片间排空微任务队列，使微任务合批近似退化为每个分片通知一次。

**按动画帧控制测试生产方节奏。** 不予采纳：生产方会在渲染变慢时同步减速，使页面获得真实网络流不存在的隐式背压，并掩盖主线程饥饿。

**真实模型或录制的 HTTP 字节流。** 不予采纳：实时模型不具确定性，HTTP/SSE（Server-Sent Events）录制也不会改进目标断言。内存 fixture 保留逐个异步会话事件、生产客户端归并和 React 渲染路径，同时控制工作负载与到达节奏。

## 后果

流式 `ConversationSnapshot` 的发布频率受浏览器绘制频率约束，React 每帧至多处理一个包含全部已接收文本的累计 partial；结构事件仍可更快发布。接收、排序、日志记录、字符串拼接和累积器更新仍按原始分片执行，因此该决策降低的是快照重建与 React 工作，不把原始流解析成本伪装成已解决。

折叠 Think 摘要的横向布局读写最多每三帧执行一次，并直接追上该时刻的最新位置；React 仍按累计快照正常提交，定稿时摘要恢复到首行。该局部视觉策略不会改变正文滚动和用户交互的即时性。

浏览器压力车道继续提供真实组装应用上的响应性信号和可见 profiling 入口，但硬件与调度差异使其只适合作为显式性能证据。确定性的 focused tests 负责守住发布次数、累计内容与抢占顺序，默认测试车道保持快速。
