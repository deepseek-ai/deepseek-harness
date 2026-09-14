# Agent Note: CI 断言等待所属操作完成

Status: implemented

[English](2026-09-08-ci-readiness-and-completion.md) | 中文

## 问题

master 空 PR 的运行 (run 34206953049)在等待 Webhook Session 创建一秒、等待 PowerShell 输出五秒时失败。两个测试都不衡量启动延迟保证。另一次运行 (run 34207864157)在 Desktop worker 就绪测试中暴露了相同的局部短时限问题，并在输入框仍保留已提交命令时截取了反馈确认。

另一次 Windows coverage 运行 (run 34224004885, job 102053583437)报告了 publint 子进程退出状态为 null，以及 LSP 初始化标记等待超时。对应 helper 在通道的 90 秒测试预算内另设五秒和三秒限制。这些用例验证发布内容与取消行为，不衡量冷启动延迟。

ACP coverage 运行 (run 34242280527, job 102115221228)在传输失败后耗尽一秒的注册表轮询期限。断连清理包含取消、输出排空、持久化和 owner 处置；仅从注册表移除不能证明完整拆卸已经结束。

一次 worker runtime coverage 失败 (run 34248221544, job 102135631932)耗尽了慢 binding 夹具的一秒计算额度。原生 Windows 并发复现在调用 binding 前已超过该额度。Worker 初始化会累计所测的活跃时间；延迟的 binding 累计空闲时间。

Windows 覆盖率运行 (run 34324325375, job 102377982193)报告了 SDK 子进程退出超过测试设置的 200 毫秒确认期限，以及 Inspector Worker 启动超过十秒默认期限。协议错误转发用例和 Cordis 树投影用例都不衡量这些延迟保证。

## 决策

[Webhook 浏览器测试](../../../../apps/web/tests/github-ready-review.e2e.ts)观察投递触发的模型请求后再检查 Session 注册。[反馈测试](../../../../apps/web/tests/feedback-command.e2e.ts)在比较 ARIA 输出前等待输入框清空且附件按钮启用。连续两次快照相同不能证明命令 RPC 已完成：事件流可能先发布确认消息。

[Desktop 事务测试](../../../../apps/desktop/tests/project-manager.spec.ts)为 worker 就绪标记使用当前测试的执行预算。独立的 `afterEach` 在删除私有目录前释放并等待 worker，包括运行器放弃超时测试体的情况。轮询观察运行器的取消信号，teardown 独立报告事务失败，不覆盖断言失败。[PowerShell 测试](../../../../packages/shell/pwsh-local/tests/executor.spec.ts)在初始化插件前登记每个 helper 创建的 Context，并在删除临时目录前处置这些 Context。后台输入用例等待进程完成后检查完整输出、完成状态与退出码。消费式读取仍由独立的流式测试覆盖。

[publint runner 测试](../../../../scripts/publint-all.spec.ts)将当前测试预算传给子进程，并在解释退出码前检查启动错误和终止信号。[LSP 实例测试](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts)用同一预算等待 fixture 标记，在取消前观察实际尚未完成的 `didOpen` 写入，并在等待就绪前接住查询的 rejection。[服务器 fixture](../../../../packages/lsp/lsp-stdio/tests/fixture-server.ts)在暂停 stdin 后发布标记。Teardown 在首次 await 前捕获实例列表、Context 和目录。

[ACP 断连测试](../../../../packages/acp/acp/tests/dispose.spec.ts)在 EOF 和传输失败两种情况下等待真实 Session handle 的 disposer。屏障阻塞处置，供测试检查所有权，然后释放屏障，等待完成并检查两个注册表。两个用例都不调用插件处置来触发待验证行为。独立的 teardown hook 在处置捕获的 Context 前释放屏障，包括测试体超时的情况。

[子 Agent 拆卸决策](2026-09-07-subagent-teardown-test-budgets.zh.md)负责生命周期清理预算。[持久 PowerShell 决策](2026-09-07-pwsh-ci-observable-completion.zh.md)负责精确与推断的终端就绪状态；一次性进程的完成 Promise 具有不同语义。

[沙箱 Node 决策](../architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md)取代 worker 活跃时间计量。[Node 运行时套件](../../../../packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts)通过真实受管进程验证替代的经过时间截止。本说明中其他完成观测与测试生命周期规则保持有效。

[SDK 子 Agent 协议错误测试](../../../../packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts)使用提供方正常的关闭和退出等待时间，并在断言前登记清理。[Inspector 树测试](../../../../packages/experimental/inspector/tests/cordis-tree.host.spec.ts)将当前测试预算传给 Worker 启动，并在启动尚未完成时登记清理。取消后的测试不会收到随后才就绪的实例；清理等待初始化完成，并关闭成功启动的 Worker。初始化失败时，启动操作会在拒绝前终止 Worker。受控的延迟启动测试通过真实 Worker 的 HTTP 端点验证取消和关闭。生产默认值不变。

## 考虑过的替代方案

**增大独立等待时限。** 已有完成 Promise 时不采用。独立轮询期限仍会与执行通道的预算竞争。

**刷新反馈 golden。** 不采用：保留内容的输入框与禁用的附件按钮描述了尚未完成的提交。已稳定的预期 UI 仍是目标行为。

**串行化 CI 或重试这些测试。** 不采用：两者都不能建立缺失的完成条件，也不能在断言失败后释放阻塞的子进程。

## 后果

就绪与输出断言保留原有的内容和所有权检查。受控的 Desktop 就绪、Webhook 预检、命令响应、PowerShell 输出、publint 启动及 LSP 初始化延迟可复现原始失败，并在采用完成等待后通过。阻塞 Desktop worker 的控制用例仍报告测试超时，同时证明 teardown 在删除目录前等待子进程退出。执行通道分别限制测试体和清理 hook；PowerShell 和进程清理仍需在原生 Windows 上验证。
