# Agent Note: PTC 的沙箱 Node 执行

Status: implemented

[English](2026-09-11-sandboxed-node-ptc-runtime.md) | 中文

## 问题

Node worker 隔离 JavaScript 状态，但不应用调用 Session 的 OS 沙箱策略。模型代码可以直接导入文件系统与子进程 API，绕过工具策略路径，即使嵌套 `tools.*` 调用受到正确检查。终止 worker 也不能证明其子进程已停止。

[PTC 基础](../feature/2026-06-15-ptc.zh.md)继续负责注册表呈现、生成绑定、分派日志和一次性结算。本决策取代其中基于 worker 的执行、信任与预算实现，同时保留消费方规则。

## 决策

`dsh-ptc-runtime-node` 在一个全新 Node 进程中运行每个程序。Host 解析执行选择，通过与 Bash 相同的 `ctx.sandbox` 提供方约束启动，并将进程生命周期交给 `ctx.subprocess`。子进程以直接 Node API、空模型环境和 Host 提供的异步绑定求值可擦除 TypeScript。本提供方不保留 worker 或持久内核。

### 已解析输入与策略

`PtcRuntime.resolve(request)` 验证支持的选项并补全 `PtcRunSpec`；`run(spec)` 不引入默认值。PTC 传入调用 Session 的 cwd 与已解析常设策略。直接运行时调用方通过同一解析器取得部署默认值。文件系统与子进程提供方共享一个执行世界，bootstrap 路径通过文件系统的显式宿主文件映射或配置的预安装 bootstrap 传递。

文件模式、观察到的拒绝与强制完整性通过 `PtcRunResult.sandbox` 独立于程序结果传递。所需沙箱后端无法启动时，受限执行失败。完整访问是显式策略模式。程序成功不证明完整强制能力，`process` 描述符与额外控制管道也不声明多租户隔离。

私有 Python 提供方保留现有执行实现与配置的经过时间截止。其解析器接受 cwd，但拒绝显式文件策略或单次 timeout 覆盖；能力描述符不会静默授予不受支持的保护。

### 控制与生命周期

子进程所有者提供专用的继承式二进制控制通道，与程序 stdout/stderr 及 launcher 生命周期 IPC 分开。Host 限制帧、排队写入、待处理调用和未完成参数字节，然后在分派前验证调用身份与绑定允许列表。模型代码可以写入该通道，因此其中字节仍不可信。

程序完成、超时、取消与协议失败都通过受管进程所有者关闭执行。选择结果后停止执行计时器；清理随后等待直接结果与受管范围停稳。PTC 桥接在外层工具结果结算前，另行取消并排空嵌套工具分派。拒绝或传输失败绝不自动重放可能已经产生副作用的程序。

### 资源限制

默认经过时间截止为 120 秒，默认上限为 600 秒。可信服务消费方可以请求 `timeoutMs: null` 来禁用该定时器；[工作流沙箱复用](2026-09-13-workflow-ptc-sandbox-reuse.zh.md)负责这种由调用方控制的生命周期。省略 timeout 或使用数值的请求（包括面向模型的 `run_code`）保留数值默认值与上限。启用的截止包括运行时准备以及嵌套工具或审批等待。V8 老生代内存、序列化外层输出与控制通信具有独立配置的上限。堆限制不包含原生分配和后代内存，经过时间也不是进程树 CPU 预算。

## 考虑过的替代方案

**保留 worker 并增加工具检查。** 工具检查不能拦截直接 Node 导入，也不能建立 OS 约束。在受限监督进程中保留 worker 可以保留 worker 计量，但会增加一层执行生命周期，仍不能提供进程树 CPU 限制。

**使用同进程 JavaScript realm。** 语言级 realm 不强制直接 Node API 所需的文件系统与进程策略。所需保护是 OS 约束与 Host 拥有的进程生命周期。

**复制 Codex Code Mode 的执行模型。** [Codex Code Mode](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/code-mode-protocol/src/description.rs) 提供全新原始 JavaScript isolate 与 Host 工具回调，yield/wait 观察与执行生命周期分开。移除 Node API 或增加可恢复单元会改变 PTC 的编程与日志模型。保留的设计在 OS 策略下提供直接 Node 访问，并返回一次性结果。

**把 worker active time 当作 CPU 限制。** 事件循环占用率计量单个 worker 的活跃经过时间，不是 Node 及其后代消耗的 CPU。进程提供方使用 Host 拥有的经过时间截止，不作更强声明。

## 后果

每次 `run_code` 都承担 Node 进程启动与 OS 沙箱准备成本。较长的嵌套工具和审批消耗与直接程序工作相同的经过时间预算。清理可能让调用方在截止后继续等待。更强的后代约束仍取决于所选子进程后端；其 fallback 限制保持可见，不会被运行时标签提升。

`run_code` 要求程序及其描述。服务调用方可以解析支持的执行选择；面向模型的 timeout 与审批控制由独立消费方负责。每个嵌套工具仍经过正常策略与日志路径。

<a id="deferred-timeout-design"></a>
## 延后评估 timeout 设计

经过时间默认值是可以重新评估的部署选择。后续设计必须将响应及时性与终止分开：向模型交出输出本身不会停止程序；增加可等待单元会引入所有权、取消、部分输出日志、轮次结束和恢复义务。

开放问题包括审批等待是否消耗程序预算、顺序执行的长任务工具如何组合、是否需要独立的总生命周期兜底，以及哪些进程树 CPU/RSS 上限可以一致强制执行。持久内核还需要在 Session 日志中表示保留状态。这些问题不会静默暂停或延长已发布的经过时间计时器。
