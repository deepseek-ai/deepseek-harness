# Agent Note: 反馈门控的会话遥测默认值

Status: implemented

[English](2026-08-25-feedback-gated-telemetry-default.md) | 中文

## 问题

诊断一条 `/feedback` 报告需要报告所描述的会话数据。共享基础配置把未设置的 `DSH_TELEMETRY_MODE` 解析为 `DISABLED`，因此默认安装发出的反馈到达接收方时不带任何会话数据，报告者在求助的那一刻也没有授权共享的途径；只有事先导出了 `DSH_TELEMETRY_MODE` 的部署才能交付可诊断的报告。

## 决定

共享 dsh 基础配置把未设置或为空的 `DSH_TELEMETRY_MODE` 解析为 `FEEDBACK_ONLY` 而不是 `DISABLED`。用户记录 `/feedback` 之前不上传任何数据。对于已经捕获的 Session 对象，每条反馈会上传从上次交接之后至该事件的后缀。新对象从 constructor boundary 开始：全新 Session 从 seq 0 开始，而 fork、resume 或迁移 Session 排除 constructor seed，从本生命周期的 `session/end-seed` 开始。因此，确认信息中的共享声明与所释放的生命周期本地前缀一致。`FULL` 和 `DISABLED` 仍是显式的 `DSH_TELEMETRY_MODE` 覆盖值，任何非空的 `DSH_TELEMETRY_DISABLED` 仍是加载前的强制关闭开关，插件自身省略 `mode` 的默认值仍是 `DISABLED`：默认值只在共享基础配置的配置表达式中改变，部署本来就在那里覆盖它。

本决定取代[默认关闭决定](2026-08-10-telemetry-default-off.zh.md)中会话后端的默认值，把用户显式的反馈动作接受为该决定原本要求由部署设置提供的释放授权。该决定的强制关闭开关和 launcher 上报历史仍然有效，端点、批处理节奏和退出排空设置仍由[默认挂载决定](2026-07-31-web-telemetry-default-mount.zh.md)持有。

## 考虑过的替代方案

**保持 `DISABLED`，让报告者带着 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY` 重跑。** 否决：值得上传的正是出现问题的那个会话，重跑会丢掉它。

**默认 `FULL`。** 否决：没有任何用户动作的持续导出正是默认关闭决定所禁止的，全新安装中没有任何东西授权它。

**改为在反馈时门控官方 DeepSeek `dsh_session_log` 请求贡献，而不是恢复 OTel 默认值。** 此处未采用：该贡献通过后续 LLM 请求上传，而不是在反馈边界上传，会话的最后一条反馈永远不会被交付；在那条路径上做反馈触发的冲刷是比翻转默认值更大的设计。

## 后果

- 全新安装只在用户记录 `/feedback` 时把尚未共享的会话日志记录上传到生产 collector；没有其他触发上传的途径。
- 释放的导出仍是未加工的原始副本：随附基础配置没有挂载 `session-telemetry/record` 脱敏规则，导出可能包含消息文本、工具参数和结果，以及 workspace 路径。
- 共享声明是 `/feedback` 确认信息的一部分，用户读到它时释放已被触发。要求事先知情同意的部署必须把默认值覆盖为 `DISABLED`，或在上传前增加确认步骤，此默认值在那类部署中才站得住。
