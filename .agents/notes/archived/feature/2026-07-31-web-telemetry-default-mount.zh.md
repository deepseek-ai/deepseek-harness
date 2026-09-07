# Agent Note: dsh web 组合默认挂载会话遥测（OTel 上报）

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-web-telemetry-default-mount.md) | 中文

## 问题

遥测 seam 与 OTel 后端（[revival Note](2026-07-23-session-telemetry-otel-revival.zh.md)）自完成以来从未接入任何部署组合：没有 roster 行、没有开关、没有节奏口径，内部部署对用户会话的可观测性为零。需要一个部署决策：哪些 surface 上报、报到哪、什么节奏、怎么关、CI 怎么隔离。

## 决策

共享 dsh 基础组合包（`packages/bundle/base/cordis.patch.yml`）挂载带有内置生产 endpoint 的 `session-telemetry-otel` 配置行，使每个基于 base 的 profile 都具有一致的遥测能力。独立的 [`sdk-minimal` profile](../architecture/2026-08-24-standalone-sdk-minimal-profile.zh.md)刻意省略该配置项。[默认关闭决策](2026-08-10-telemetry-default-off.zh.md)最初让已挂载配置项保持 `DISABLED` 模式；[反馈门控默认值决定](2026-08-25-feedback-gated-telemetry-default.zh.md)现在把未设置的模式解析为 `FEEDBACK_ONLY`，只在用户记录 `/feedback` 时上传。仅配置 endpoint 仍不构成上报授权。Web 与 headless 在 SIGINT/SIGTERM 时使用[有界、可升级的进程关闭控制器](../bug-fix/2026-08-03-cli-signal-shutdown-escalation.zh.md)，在启动器 5 秒上限到期前，先给已启用的后端 3 秒关闭截止时间完成排空。

| 决策项 | 取值 | 理由 |
|---|---|---|
| 挂载面 | `packages/bundle/base/cordis.patch.yml` | 每个加载共享基础组合包的 profile 都使用同一个能力配置行 |
| 共享模式 | `DSH_TELEMETRY_MODE`，默认 `FEEDBACK_ONLY`（[反馈门控默认值决定](2026-08-25-feedback-gated-telemetry-default.zh.md)）；显式设置 `FULL` 或 `DISABLED` 即覆盖 | 新 profile 只在用户记录 `/feedback` 时上传，内部部署仍可使用两种显式策略 |
| endpoint | `DSH_TELEMETRY_OTLP_URL`，缺省 `https://harness-telemetry.deepseeksvc.com/v1/logs` | 内部 collector；env 覆盖供本地/联调 |
| 硬性退出 | `DSH_TELEMETRY_DISABLED` 非空（含 `0`/`false`）即禁用该配置行 | 启动器 patch 在加载期传输校验之前生效，并覆盖所有已配置模式 |
| 上报节奏 | 上传模式中为 `processor.scheduledDelayMillis: 10000`（10s/批） | 在会话运行期间流式上报，而非仅在退出时上报；崩溃至多丢失最后一个尚未导出间隔内的数据 |
| 退出 drain 上界 | `exporter.timeoutMillis: 1000` + `maxExportBatchSize: 2048`（与 maxQueueSize 相等） + `exportTimeoutMillis: 1500` + `shutdownTimeoutMillis: 3000` | collector 不可达的常规故障会在约 1s 内放行：timeoutMillis 是单次 socket 超时与重试 deadline，使用与队列等大的单批可避免依次排空导致耗时倍增。由 DSH 管理的 3s 外层上限覆盖 SDK 先执行的无界 `forceFlush()` 等待，即传输 Promise 始终无法取得 socket 的情况。 |
| 压缩 | `compression: gzip` | 事件 body 含全文，跨机房带宽 |
| CI 隔离 | GitHub 工作流顶层 `env: DSH_TELEMETRY_DISABLED: '1'` | 即使 CI 任务显式选择上传模式，纵深防御也会让测试会话留在本地 |


基础组合包测试固定交付的 `FEEDBACK_ONLY` 模式表达式，后端测试套件固定省略模式时不构造传输，真实 Loader 组合测试则在验证 OTLP 投递时显式选择每种上传模式。

## 考虑过的替代方案

**默认不挂载，部署方自行添加配置行。** 不采用：挂载的 `DISABLED` 模式会保留本地反馈警告，并为每个基于 base 的 profile 提供同一个 patch 目标，同时不授权任何上传。

**开关做成 config 字段而非 env patch。** 不可行：cordis 行没有 config 层的 disable 语义，且 `exporter.url` 校验在插件构造期 fail-loud，开关必须在 Loader 之前生效——AppCLIEntry patch 层是唯一落点。

**退出时 `Promise.race` 兜底超时。** 最初暂缓，是因为 SDK 参数看似已经将后端排空耗时限制在约 1.5-3s（通常 <100ms），实测 SIGINT 到退出耗时 110ms-1.1s。后来在 Linux 沙箱中复现并证明，`BatchLogRecordProcessor.shutdown()` 可能在 `exporter.forceFlush()` 中永久等待，无法进入受 `exportTimeoutMillis` 限制的完成 Promise。因此，[CLI 关闭修复](../bug-fix/2026-08-03-cli-signal-shutdown-escalation.zh.md) 既为这一特定缺口增加 3 秒后端上限，也为整棵插件树增加 5 秒进程级上限和重复信号退出途径。

## 后果

- 开发者运行没有遥测配置的 `dsh web` 时，在记录 `/feedback` 之前不会发出遥测网络请求。内部部署需设置 `DSH_TELEMETRY_MODE`，并可让 `DSH_TELEMETRY_OTLP_URL` 指向其他 collector。
- **没有挂载任何脱敏规则**：显式启用的导出即原始捕获副本（用户/助手消息全文、工具参数与工具结果、系统提示词、`session.cwd` 本地路径）。跨信任边界前必须先挂载 `session-telemetry/record` 规则；脱敏规则、其余身份 Resource 属性和使用情况指标仍是独立的部署工作。匿名 user id 由[匿名 user id Note](2026-07-31-telemetry-anonymous-user-id.zh.md)交付。
- 测试载具默认将数据留在本地；显式启用上传模式的测试提供自己的 collector 和模式。
