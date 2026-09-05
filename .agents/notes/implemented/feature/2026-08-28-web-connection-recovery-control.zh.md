# Agent Note: Web 连接恢复控件

Status: implemented

[English](2026-08-28-web-connection-recovery-control.md) | 中文

## Problem

Web Client 会在故障后自动重建 Remote event generation 与物理 WebSocket，但页面既不显示断联，也不提供用户恢复操作。logical generation 与 physical socket 的重试循环还可能错位：`retry #N` 消息可能描述另一个 logical generation，而浏览器仍在等待同一个物理连接候选。Host 每 30 秒才发送一次空闲 WebSocket Ping，用户在恢复 Host 或网络后也无法主动要求一次全新尝试。

## Decision

Host 默认通过既有且经过校验的 `websocketHeartbeatIntervalMs` 配置，每 2 秒发送一次 WebSocket Ping 控制帧。每次 Ping 前，它把 socket 标记为等待 Pong；到下一间隔仍未收到 Pong 的 socket 会被终止。`ConnectionController` 是唯一的 retry 调度器。在线状态下的传输失败进入带抖动的指数退避：上限从 500ms 开始，依次翻倍为 1s、2s、4s、8s，最终封顶 10s；实际延迟是上限的 50%–100%。[持续恢复决策](../bug-fix/2026-09-05-continuous-client-recovery.zh.md)取代本笔记的有限重试策略：达到间隔上限后仍继续尝试，握手就绪设有硬期限。每次物理 retry 都发布 `connecting`、写一条 `retry #N` warning、要求 Gateway mux 恰好一次替换候选或活动 socket，再重开内部 `$events` stream。

Client Connection 服务暴露 identity 稳定的 `ctx.connection.state` observable 与 `ctx.connection.reconnect()`。snapshot 在首次连接结果前为 undefined，此后为 `disconnected`、`connecting` 或 `connected`；等价状态不触发通知。手动重连会中断当前 generation 或重试等待、重置 attempt 序号，并通过与自动恢复相同的物理和逻辑路径立即开始 retry 1。浏览器的 `offline` 事件会立即中断活动连接工作、发布 `disconnected` 并暂停自动 retry；下一次 `online` 转换会发布 `connecting`、重置 attempt 序号，并从 500ms 退避档重新开始；重复事件不会创建另一条循环。Host 是否可达由新的 `$events` ready 帧证明，而不是由 `navigator.onLine` 证明。替换 generation 建立后，各 logical stream 仍自行持有 baseline、cursor 与 replay 语义。

[Web Client 架构](../architecture/2026-07-19-gui-web-client-architecture.zh.md)、[Remote 事件投递](../architecture/2026-08-10-remote-event-delivery.zh.md)和[会话事件传输](../architecture/2026-08-18-session-history-and-event-transport.zh.md)继续持有各自更宽的所有权决策；本笔记只取代其中原有的重试时序。

Settings 外壳是恢复功能专用消费方，因此直接注入 Connection；普通功能代码仍使用 `ctx.remote`。它的私有 hooks compartment 绑定状态 observable 与重连命令。展开的侧边栏在 Settings 右侧渲染 `ConnectionIndicator`：`disconnected` 是浅黄色的**连接异常**操作；`connecting` 以黄色显示**自动重连中**，其中一至三个点每 500ms 前进一次，与 retry 时序无关；恢复后则以浅绿色显示**连接成功**并驻留 2 秒。鼠标悬浮或键盘聚焦任一黄色状态时只把文字改为**立即重连**；按压反馈采用轻微的警告色过渡，不使用原生 title tooltip。所有可见状态都为最宽的本地化文字预留空间，并使用固定的图标列和左对齐文字列，因此状态变化不会移动控件或改变其宽度。首次启动和未曾中断的健康连接都不渲染。

## Alternatives considered

**固定每 2 秒重试且不进入终态。**不采用，因为长时间故障会持续产生连接流量。保留的指数策略先快速重试，再逐步降低频率，并在重试期间保留恢复操作。达到间隔上限后的重试由持续恢复决策规定。

**在视口顶部渲染全宽 `ConnectionBanner`。**不采用，因为状态应放在用户指定的恢复操作旁，全局覆盖层还会占用无关页面界面框架。该原语是内联 `ConnectionIndicator`；首次标签发布前不存在 `ConnectionBanner` 兼容导出。

**通过 `ctx.remote.$connection` 暴露生命周期控制。**不采用，因为 retry 状态与命令属于 Connection 服务，而不是 Remote 方法 namespace。直接使用 `ctx.connection` 仍是例外；本指示器本身负责控制重连，因此符合该例外。

**仅在用户点击时重试。**不采用，因为用户没有观察页面时仍必须自动恢复；按钮会重置退避并跳过当前等待。

## Consequences

空闲浏览器连接的心跳流量会高于原默认值；长时间故障则按持续恢复决策保留间隔封顶的连接尝试。部署仍可覆盖 Host Ping 间隔。Gateway mux 不拥有第二个 retry timer，因此每条 `retry #N` warning 都对应一次由 Controller 请求的物理尝试。

手动重连会刻意中断共享物理 socket 的全部 logical Remote stream。它们既有的 generation supervisor 会通过新 baseline 或 cursor 恢复状态；单向通知仍不重放。

连接状态与浏览器网络输入都位于 React-free 传输层。Settings 组件只接收框架绑定的 selector hook 与普通回调，因此没有 UI store 复制传输状态；只有 2 秒成功提示和 500ms 点动画属于展示层本地状态。

## Testing

Connection 与 Gateway 测试固定 2 秒心跳及 Pong deadline、指数 retry 间隔上限与日志、浏览器离线暂停和在线重置、手动重置序列、每次请求只替换一个 socket、状态去重、listener 隔离与 dispose。组件测试固定健康状态下不显示、悬浮与操作文案、独立点动画、点击行为与 2 秒成功状态。组装 Web 测试通过随附浏览器应用驱动浏览器 offline/online 转换、失败的 WebSocket 尝试、稳定的指示器几何、手动恢复与成功确认。
