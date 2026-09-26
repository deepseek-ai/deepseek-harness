# Agent Note：由 consumer 持有启动严格语义

Status: implemented

[English](2026-09-09-consumer-owned-startup-strictness.md) | 中文

## 问题

Best-effort Loader reconcile 会保留可用 plugin，但应用仍需一组最小 capability。HTTP 应用没有 listening server 就不算运行，而一个 tool 不可用时可以仅省略该 tool，剩余应用仍然可用。Cordis 无法从 plugin 实现或依赖状态推断这一区别。

## 决策

DSH 在 vendored Cordis 之外持有启动严格语义。App-boot 用一份全局稳定 entry id list 审计已结算的初始 tree。List 中存在、启用且未 active 的 entry 会使启动 reject，并拆卸应用。List 中缺失或禁用的 id 不产生影响。Bootstrap Include 按 entry 身份被视为 required，因为根配置缺失或无效会阻止应用组装。其他 inactive entry 输出一次 warning，并让成功 sibling 继续运行。

Required id 为 `agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp` 和 `sdk-jsonrpc-server`。它们分别代表共享 Agent 执行、应用 endpoint，以及 Web 启动与传输。即使 HTTP server 不依赖它们也能监听，Web 仍需要客户端模块注册表和经过认证的连接。通过注入已成为必需项的 provider 不需要单列：它们缺失时，已列出的消费方会保持 pending 或失败。

审计将 `disabled` 表达式抛出的异常视为 entry 失败，而不是 entry 已禁用，因为求值未能确定是否跳过它。该失败遵循相同的 optional/required 策略。

该审计只在应用首次启动时运行。之后的 config HMR 仍采用 best effort，并保留 failed candidate 供后续修复。

该策略适用于 [Web host 启动](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)，包括其 [client 插件名册](2026-07-23-client-plugin-loading-model.zh.md)。[按会话的 preset](2026-09-18-declarative-agent-presets.zh.md)持有独立的严格子树审计。

## 考虑过的替代方案

- **给 vendored Loader 增加 transactional 与 best-effort mode。** 拒绝，因为严格语义属于应用或资源 owner，而一个 Loader group 包含互不相关的 plugin。Mode 还会扩大 vendor patch，并要求 caller 为每个 group 选择 policy。
- **在每个 profile 中声明 required entry。** 拒绝，因为相同应用 endpoint 会在 profile data 与 custom profile 中重复。全局 list 会忽略缺失 id，同时让稳定的随附 id 保持权威。
- **把所有启动失败都视为 optional。** 拒绝，因为无法暴露所选应用 endpoint 的进程必须报告启动失败。

## 后果

稳定的 required entry id 是应用 assembly 的一部分。重命名时必须同步更新 list 与测试。Optional plugin failure 会保留在 Loader state 和 stderr 中，但不会拆卸 active sibling。Required failure 将所有 inactive entry 合并到一份诊断中，区分失败插件与等待服务的插件，并标记 required entry。App-boot 拆卸 root 后，`StartupError` 仍以 cause 保留原始失败。CLI 仅输出其消息一次，并以退出码 1 结束，避免重复的包装堆栈，同时保留插件堆栈、嵌套原因和聚合错误成员。CLI 将原始错误、未激活条目的元数据及启动警告、错误记录保存到直接位于 `$DSH_HOME/logs/` 下的唯一报告中，保留简洁终端输出省略的导入错误和错误属性。写入失败时，完整报告回退到 stderr，退出码仍为 1。其他异常继续作为未处理异常抛出。

简洁的终端报告突出失败插件；单独文件保存原始诊断，不受默认 logger 缓冲区记录数限制。原始错误值保持完整，因此报告附带分享提醒，不会静默脱敏字段。独立的 exporter 生命周期覆盖应用的异步资源释放。CLI 等待 stderr 写入完成后明确退出，因为失败插件可能留下 stdin 或其他打开的句柄。

## 测试

App-boot 单元测试覆盖缺失和禁用的 required id、optional import failure、config evaluation failure、同步和异步 `apply()` failure、pending dependency，以及 required failure teardown。单元预期输出固定诊断分组、原始错误对象与导入日志的保留、exporter 清理、完整诊断值、私有文件创建、并发报告命名以及写入失败回退行为。构建后的 Web-profile acceptance 断言端口冲突堆栈只输出一次且不包含 Node 包装输出，验证已保存的诊断文件及其 stderr 回退，并会在 optional failure 存在时继续提供完整 UI，并在 required HTTP port 被占用或 `modules`、`connection` 无法激活时以非零码退出，且不报告就绪。

[Web 进程矩阵](../../../../apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts)分别验证启动时和原生补丁文件修改后的 optional 与 required 失败。经过认证的 HTTP 请求和插件生命周期文件区分可用应用与仅存活的进程。这些无需密钥的进程检查与[受控事件投递单元测试](../testing/2026-09-09-user-patch-hmr-test-delivery.zh.md)互补：单元测试隔离配置协调失败，进程测试还要求随附启动器、原生监听器和有界关闭流程协同工作。

矩阵启用 Chokidar 的 `awaitWriteFinish`，在每次重载前确认文件内容已稳定；否则它的短暂 change 事件抑制窗口可能丢弃下一次测试编辑。测试仍然依赖原生事件，并等待观察到激活或失败，而不是固定时长的休眠。这是显式测试配置，不能证明默认监听器的时序行为。
