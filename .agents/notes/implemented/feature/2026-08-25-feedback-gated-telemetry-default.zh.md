# Agent Note: 反馈门控的会话遥测默认值

Status: implemented

[English](2026-08-25-feedback-gated-telemetry-default.md) | 中文

## 问题

诊断一条 `/feedback` 报告需要报告所描述的会话数据。共享基础配置把未设置的 `DSH_TELEMETRY_MODE` 解析为 `DISABLED`，因此默认安装发出的反馈到达接收方时不带任何会话数据，报告者在求助的那一刻也没有授权共享的途径；只有事先导出了 `DSH_TELEMETRY_MODE` 的部署才能交付可诊断的报告。

## 决定

[显式反馈 OTel 决策](../architecture/2026-09-05-nonofficial-feedback-otel.zh.md)负责所有用户的上传授权，包括 `deepseek-official`。本记录保留基础默认值的理由：选择反馈门控释放而非持续导出。

共享基础配置把未设置或为空的 `DSH_TELEMETRY_MODE` 解析为 `FEEDBACK_ONLY`。插件自身省略 `mode` 的默认值是 `DISABLED`；`FULL` 被拒绝，非空 `DSH_TELEMETRY_DISABLED` 是加载前的强制关闭开关。新的自身文本反馈、消息评分编辑和撤回释放尚未交接的权威前缀，截止该事件，包含存储的上下文。继承的父会话反馈不授权子会话导出。

反馈门控释放让报告者无需复现问题就能共享出问题的 Session。它用显式反馈触发取代持续导出。[已归档默认关闭](../../archived/feature/2026-08-10-telemetry-default-off.md)与[默认挂载](../../archived/feature/2026-07-31-web-telemetry-default-mount.md)记录记载早期组合；当前配置由[基础补丁](../../../../packages/bundle/base/cordis.patch.yml)与 [OTel README](../../../../packages/session/session-telemetry-otel/README.zh.md) 持有。

## 考虑过的替代方案

**要求报告者启用遥测后重跑。** 不作为反馈门控工作流：值得保留的证据是出问题的那个 Session，重跑会丢掉它。

**允许持续导出。** 否决：部署配置不授权没有显式反馈的捕获。

**仅通过后续 DeepSeek 请求投递。** 独立的需显式启用的贡献可传送权威反馈，但最终反馈之后可能没有请求。OTel 为每个提供方释放反馈，无需发起另一个 LLM 请求。

## 后果

- 随附基础配置仅在新的显式反馈时释放有界前缀。普通请求、生命周期事件和已存储反馈不触发捕获。后续记录等待下一次显式反馈。
- 按需捕获在反馈时复制权威日志并脱敏。部署未挂载脱敏规则时，导出数据可能包含消息文本、工具参数和结果，以及 workspace 路径。
- 命令确认文本确认记录，而非共享或投递。要求事先知情同意的部署必须在启用上传前提供该步骤；OTel 交接仍受 SDK 的批处理、重试与丢失策略约束。
