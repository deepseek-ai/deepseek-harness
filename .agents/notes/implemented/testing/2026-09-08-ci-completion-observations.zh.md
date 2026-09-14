# Agent Note: CI fixture 的完成与隔离

Status: implemented

[English](2026-09-08-ci-completion-observations.md) | 中文

## 问题

参考 CI 运行 (run 34206953049)报告：轮询一秒后 webhook 创建的 Session 仍不存在，五秒读取期限内 PowerShell 输出为空。HTTP 接受、UI 投影状态、进程启动和持久化完成是不同的观察。测试需要明确的完成条件，并用对照阻止中间状态满足该条件。[完成等待决策](2026-09-08-ci-readiness-and-completion.zh.md)拥有这些条件与 lane 预算；这些 fixture 通过受控延迟使顺序与清理可观察。

## 决策

[GitHub 评审浏览器测试](../../../../apps/web/tests/github-ready-review.e2e.ts)在 HTTP 202 后阻塞真实 Workspace 创建，验证 Agent 和模型请求均不存在，再释放创建并等待对应 Session 的 `turn/end`。即使测试超时，清理也会释放屏障、恢复方法并移除事件监听器。Workspace 归属、请求数量、提示词内容和浏览器预期保留原有断言。

[PowerShell 执行器测试](../../../../packages/shell/pwsh-local/tests/executor.spec.ts)用私有文件屏障控制启动与消费式读取。测试决定后续输出何时可用；最终 stdin／环境变量输出在 `done` 后读取。轮询使用当前测试预算，每个创建的 Context 都在插件初始化前登记。清理在等待释放前同时取得 Context 与目录，完成释放后才删除目录。

[排队图片测试](../../../../apps/web/tests/queue-image.e2e.ts)分别阻塞接纳和附件读取，再捕获已接纳行中加载完成的缩略图。清理共享一个 Promise，释放保留的请求，并在关闭浏览器前等待其 handler 完成。

[详情 Session 生命周期测试](../../../../apps/web/tests/details-session-lifecycle.e2e.ts)在关闭状态出现后等待框架已捕获的动画 Promise，再检查轨道宽度为零。取消的过渡同样进入该断言；动画结束不能让持续非零的轨道通过。

[整队列 steering 测试](../../../../apps/web/tests/steering.e2e.ts)等待 steering 操作可用以及 composer 显示队列 steering 提示。模型流屏障在测试观察 steering 时阻止后续问题 composer 接管。清理在关闭浏览器前释放该屏障。

[Workspace 管理测试](../../../../apps/web/tests/workspace-management.e2e.ts)在下一次目录对话框操作前等待恢复后的 composer 焦点。归档用例通过 Session controller 为已知 seed id 设置显式用户标题，再用该精确标题跨重载定位行。无关的恢复行无法匹配该定位器；持久化归档断言仍检查 seed id 和保留的日志。

[Node 运行时测试](../../../../packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts)执行真实受管进程、绑定传输、经过时间截止与取消。[沙箱 Node 决策](../architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md)取代 worker ELU 预算及其受控样本测试；真实进程与传输证据仍然必要。

[分离启动测试](../../../../packages/host/open-in-app/tests/launch-detached.spec.ts)控制观察时间，并通过真实 launcher 登记的回调发送迟到进程事件。测试检查仅完成一次、仅 unref 一次且不终止子进程。[Resolver 测试](../../../../packages/host/open-in-app/tests/resolver.spec.ts)保留真实进程的环境变量和提前退出用例。

[LSP 背压测试](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts)保留真实暂停读取的 fixture 与大型原生管道写入。接受 abort 错误前，测试验证待处理写入回调已完成、捕获的子进程也已结束；`instance.dead` 在释放开始时就可能为真。

### 已构建 Client 的导入分类

[Node import sweep](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts)只有在 Node 针对某个 `.css` 文件报告 `ERR_UNKNOWN_FILE_EXTENSION` 时才接受 Dockkit bundle，其他每个错误以及每个意外成功的豁免导入都会失败；该豁免覆盖哪些样式表由[样式表豁免决策](../bug-fix/2026-09-10-built-bundle-css-exemption.zh.md)拥有。限定范围的 resolve/load hook 覆盖预期 CSS 失败、其他样式表、其他扩展名、任意失败、其他错误码和陈旧豁免，不修改共享构建产物。

## 考虑过的替代方案

**生产超时、重试或套件串行化。** 拒绝，因为均不能建立缺少的完成观察。

**从接受或预览推断完成。** HTTP 202 和乐观图片可能早于被断言的操作。

**用受控样本代替真实执行。** 不采纳，因为仅靠定时器样本无法验证进程启动、控制传输或受管清理。

## 影响

每个 fixture 拥有自己的时钟、屏障、回调、进程和临时路径。受控观察补充真实 worker、子进程、浏览器和持久化路径。产品行为、生产时序、基准预算、CI 调度和录制预期均保持不变。
