# Agent Note: Web 与 headless 的有界信号关闭和重复信号强制退出

Status: implemented

[English](2026-08-03-cli-signal-shutdown-escalation.md) | 中文

## 问题

默认挂载遥测后，`dsh web` 与 headless 命令（现为 `dsh --profile headless`）新增了 SIGINT/SIGTERM 处理器，使进程退出时可以排空 Cordis 插件树，而不是丢弃排队中的遥测数据。每个处理器都使用单向布尔闩锁（latch），并且只有在 `ctx.fiber.dispose()` 结算后才退出。headless 正常完成时同样会无界等待整棵树执行 dispose（资源释放）。

随后有用户复现，headless 命令在打印观察 URL 后立即卡死，重复按 `Ctrl+C` 也没有反应；设置 `DSH_TELEMETRY_DISABLED=1` 后不再卡死，而同一 Linux 沙箱中的独立 Node 信号处理器能够收到 SIGINT。这将待结算的 disposer 定位到遥测，而非终端信号转发。OTel 的 `BatchLogRecordProcessor.shutdown()` 会先等待 `exporter.forceFlush()`，再等待受 `exportTimeoutMillis` 限制的完成 Promise；OTLP 导出器的 `forceFlush()` 则直接等待正在进行的 HTTP Promise。因此，代理／沙箱连接始终无法取得 socket 时，即使已经配置两项 SDK 超时，也会让提供方关闭一直待结算。

闩锁随后把这个遥测缺陷变成无法终止的 CLI（命令行界面）：正常完成流程已经在等待单次根级 dispose；第一次 SIGINT 会加入同一个待结算的 dispose，并设置信号闩锁；后续 SIGINT 在闩锁处直接返回，因此进程再无退出途径。正常完成之前收到信号时，同样会陷入无界等待。Web 使用的闩锁结构与此相同。

遥测自身的超时无法证明整棵插件树都能结算。任何当前或未来的 disposer 都可能卡死；进程边界既要保留第一次优雅关闭的机会，也必须给用户留下强制退出的途径。

## 决策

修复分为两层归属。OTel 后端围绕 SDK 提供方的完整关闭 Promise 增加 `shutdownTimeoutMillis`（默认值和交付值均为 3 秒）。超过该截止时间时会以拒绝状态结算，并进入遥测协调器现有的失败隔离路径，使 Cordis 插件树能够完成 dispose；由于 OTel 未公开取消传输 Promise 的能力，待处理记录可能丢失。

Web 与 headless 共用 `createProcessShutdown`，它是围绕根级 dispose 建立的进程级控制器：

- 多次正常关闭调用会汇合到同一次 dispose，并保留首次请求的退出码；这些调用不会相互触发强制退出。dispose 成功后，控制器通过 `process.exitCode` 记录该退出码，让 Node 自然排空剩余句柄；dispose 失败时仍强制退出，因为启动器不能假定失败的插件树已经完全停稳。
- 第一个信号会启动同一次优雅 dispose，并设置一个带引用的 5 秒退出兜底。dispose 无论成功或失败都会触发且仅触发一次退出；任何一种结果都无法取消进程退出。
- 关闭待结算期间收到信号时，会立即按该信号路径的退出码强制退出。这既包括 headless 正常完成已经进入 dispose 后收到的第一次 `Ctrl+C`，也包括由信号启动排空后收到的第二个信号。
- 5 秒上限是进程安全不变式，而不是部署调节项。它足以覆盖遥测部署的常规排空时限，同时仍在启动器边界为任何卡死的 disposer 设置等待上限。

正常完成会刻意避免调用 `process.exit()`：Undici 请求刚完成后立即强制退出，可能会在原生句柄清理尚未排空时触发 Node 的 [Windows libuv 异步句柄断言](https://github.com/nodejs/node/issues/56645)。如果正常 dispose 已经完成，但仍有其他句柄让进程保持存活，信号依然可以强制退出。

headless 对完成的轮次仍以 0 退出，对其他轮次结束原因或 API 业务错误仍以 1 退出，对 SIGINT 以 130 退出，对 SIGTERM 以 143 退出。Web 保留现有行为：SIGTERM 以 0 退出，SIGINT 以 130 退出。

这项决策取代了[遥测部署 Agent Note](../../archived/feature/2026-07-31-web-telemetry-default-mount.md) 中 SDK 导出器／处理器超时能够限制提供方完整关闭流程的假设，也取代了其中暂缓进程级退出兜底的决定。后端负责导出数据丢失与延迟策略，并封住已知的 SDK `forceFlush()` 缺口；启动器负责最外层保证，确保任何插件都无法无限期困住进程。

## 考虑过的替代方案

**只限制遥测后端的 `shutdown()`。** 仍不充分：它能保护已知的 OTel 等待，但无法保护启动器免受其他插件 disposer 的影响。

**恢复 Node 默认的信号即时退出。** 不予采纳：收到第一个信号时，健康流程仍应刷新遥测数据并释放其他资源。即时退出是显式的强制退出路径，而非默认行为。

**只增加 5 秒超时。** 不予采纳：用户再次按下 `Ctrl+C`，就是要求立即停止等待。若在剩余宽限期内继续吞掉这一意图，只是缩短了报告中故障的持续时间，并未解决问题。

**dispose 成功后仍总是调用 `process.exit()`。** 不予采纳：根级 dispose 只能证明应用插件树已经完全停稳，不能证明 Node 及其原生依赖已经回收所有异步句柄。设置 `process.exitCode` 既保留请求的状态码，也允许运行时完成这部分工作。

## 后果

健康的正常退出流程仍会对整棵 Cordis 插件树执行 dispose，随后等待 Node 事件循环自然排空。已知的遥测等待最多会在 3 秒后解除；其他退出流程卡死时，如无进一步输入，最多等待 5 秒；收到信号时，仍在排空句柄的正常完成流程或待结算的关闭流程都会立即结束进程。强制退出或受截止时间限制的退出可能中断遥测导出或尚未完成的清理工作；只有优雅关闭约定已经失败，或用户明确要求强制退出时，才会有意接受这一结果。

该控制器属于启动器基础设施，而不是 Cordis 插件：它不会声称 dispose 已经完成，也不会削弱普通 disposer 必须达到完全停稳状态的生命周期规则。

## 测试

`apps/cli/tests/process-shutdown.spec.ts` 固定了 dispose 成功后的自然完成、dispose 失败后的强制退出、5 秒退出兜底、正常调用汇合、由信号发起的 dispose、信号中断正常 dispose 或 dispose 后句柄排空，以及第二次信号强制退出的行为。

`apps/cli/tests/headless-shutdown.e2e.ts` 在 PTY 中启动真实交付的 Web/headless Loader 插件树，并挂载一个仅用于测试的插件；该插件的 disposer 会声明已经进入清理流程，但永不结算。测试在观察地址出现后发送 SIGINT，等待 dispose 已启动的证据，再次发送 SIGINT，并要求进程以 130 退出。源码／产物启动解析器使两个执行平面都覆盖同一项回归。该 PTY 用例覆盖用户可见的进程状态；模型输出快照没有变化。

`packages/session/session-telemetry-otel/tests/otel.spec.ts` 在定时器导出开始后保持一条真实 OTLP 请求打开，并固定以下行为：即使 SDK 的 `forceFlush()` 仍待结算，Cordis dispose 也会在 `shutdownTimeoutMillis` 到期时返回。随后测试释放 collector，使仍受观察的提供方 Promise 干净结算。
