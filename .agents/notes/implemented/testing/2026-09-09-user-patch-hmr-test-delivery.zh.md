# Agent Note: 用户 patch 测试控制文件系统事件投递

Status: implemented

[English](2026-09-09-user-patch-hmr-test-delivery.md) | 中文

## 问题

macOS Sandbox 运行 (run 34238200206, job 102101292119) 在等待首次用户 patch 新增时超时。本地并发复现表明，没有文件系统通知到达 HMR。轮询变体也会遗漏后续修改，此时 HMR 没有待执行的刷新。这些失败阻止刷新断言执行其负责验证的解析、激活与回滚行为。

## 决策

[用户 patch 测试](../../../../packages/boot/app-boot/tests/user-patches.spec.ts) 写入真实 patch 文件，并通过不持有原生监听句柄的 Chokidar watcher 投递 add、change 和 unlink 事件。应用启动监视器注册、刷新串行化、Include 重组、插件激活、失败报告与恢复仍使用真实实现；[Loader 策略](../simplification/2026-09-09-nontransactional-loader.zh.md) 不提供插件回滚。即使初始化在进入局部清理块前失败，夹具也会恢复 watcher 工厂并销毁 Context。

独立的 [监视器测试](../../../../packages/boot/hmr/tests/watch-config.spec.ts) 负责原生通知投递，包括 add/change/unlink、初始不存在的父目录和文件系统别名。刷新测试不验证操作系统的投递保证。

## 考虑过的替代方案

**每个刷新断言都使用原生通知。** 不采用，因为这会让每次解析器与激活状态转换都重复依赖原生投递。事件缺失会掩盖下游究竟哪个行为出现问题。

**轮询与固定等待。** 不采用，因为两者都不能确认下一次修改已经投递。Chokidar 就绪状态不暴露 Node 异步初始轮询基线的完成时刻；本地轮询复现仍会遗漏修改。延长测试期限无法恢复从未发出的事件。

**Mock HMR 注册或 Include。** 不采用，因为测试必须保留真实重组、报告激活失败，并在解析失败后保留运行中的配置。

## 影响

刷新序列保留其语义断言，并移除固定的 change 节流等待。独立并发进程验证隔离性，强制初始化失败则验证 watcher 在下一用例前关闭、工厂在下一用例前恢复。原生 watcher 失败仍在其所属测试中可见，需要单独诊断。
