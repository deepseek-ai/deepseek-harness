# Agent Note: 遥测必须显式启用

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-telemetry-default-off.md) | 中文

## 问题

DeepSeek Harness 有两路出站遥测数据流。在内测阶段，共享基础配置挂载了带内建生产 endpoint 的遥测，两路数据流默认上报以帮助诊断上报的问题：会话 OTel 后端在省略 `mode` 时可能导出完整会话内容、工具数据、提示词和工作区路径，而 dsh-sdk 启动器数据流则无条件外发。因此，全新安装无需部署方明确选择便允许向外上报。

## 决策

两路数据流都使用 `DSH_TELEMETRY_MODE` 作为正向授权配置。未设置和空值都解析为 `DISABLED`。`@deepseek-ai/dsh-session-telemetry-otel` 也将省略的 `mode` 解析为 `DISABLED`；该模式不构造 OTel 提供方、处理器或导出器，并将反馈留在本地会话日志中。dsh 共享基础配置继续挂载后端配置行，使禁用模式仍可在记录反馈时说明没有共享任何内容。部署方通过 `FULL` 或 `FEEDBACK_ONLY` 显式启用 Session Log 共享；只有 `FULL` 还允许 dsh-sdk 启动器上报。共享基础配置中会话后端的默认值后来被[反馈门控默认值决定](2026-08-25-feedback-gated-telemetry-default.zh.md)取代，未设置的 `DSH_TELEMETRY_MODE` 解析为 `FEEDBACK_ONLY`；硬性退出开关和下文的启动器规则仍然有效。任何非空 `DSH_TELEMETRY_DISABLED` 仍是具有最高优先级的加载前硬性退出开关。[默认挂载决策](2026-07-31-web-telemetry-default-mount.zh.md)继续负责 endpoint、批处理节奏和退出排空设置。

dsh-sdk 启动器读取同一变量，不解析 `cordis.yml`，也不启动 Cordis。`FULL` 允许上报；`FEEDBACK_ONLY`、`DISABLED`、未设置和空值都会拒绝。授权在命令执行前从启动环境冻结：`dsh-sdk start` 会加载项目 `.env`，项目代码也能修改 `process.env`，若在执行后解析，项目便能自行授权上报其自身配置，而[配置来源所有权决策](../architecture/2026-08-04-configuration-source-ownership.zh.md)对整个 `DSH_*` 命名空间禁止这种行为。在该边界上，不受支持的模式按拒绝处理而非抛出，因为遥测不得改变命令结果。此规则在启动器及其提案被[SDK 项目工具链移除决策](../simplification/2026-08-11-remove-sdk-project-toolchain.zh.md)删除之前，仅取代了启动器默认允许上报的规则。

[CLI reference README](../../../../apps/cli/reference/README.zh.md) 记录了当前的部署口径：共享基础配置默认按反馈门控共享（[反馈门控默认值决定](2026-08-25-feedback-gated-telemetry-default.zh.md)），`DSH_TELEMETRY_MODE=FULL` 和 `DSH_TELEMETRY_MODE=DISABLED` 是显式覆盖值，开启后的导出可能包含完整会话内容。恢复后的[测试阶段引导声明](2026-08-13-shared-modal-product-onboarding.zh.md)不包含遥测文案，因此产品仍不提供任何关于开启上传的提示。

## 考虑过的替代方案

**保留默认退出机制并改进披露。** 不采用：披露不能让缺少配置构成发送数据的明确授权，尤其是会话遥测可能包含完整的本地内容。

**将会话遥测默认设为 `FEEDBACK_ONLY`。** 不采用：即使部署方没有显式启用向外上报，记录反馈仍会触发上传。默认值必须让会话及其反馈都留在本地。

**添加项目级授权标记。** 不采用：`DSH_TELEMETRY_MODE` 已能表达两路数据流的授权；另一个配置项会产生冲突设置，并需要启动器专用的解析逻辑。

**删除两种遥测实现。** 不采用：内部部署仍需要显式启用 `FULL` 与反馈触发的上报；在 `FULL` 下，启动器数据流也仍有用。

## 后果

全新 profile 和项目在用户记录 `/feedback` 之前不发出任何遥测网络请求（[反馈门控默认值决定](2026-08-25-feedback-gated-telemetry-default.zh.md)）。`FULL` 仍需显式设置；它曾一并启用的启动器数据流已随 SDK 项目工具链删除。现有硬性退出继续生效，上传模式也保留 endpoint 校验、脱敏责任、批处理和关闭行为。
