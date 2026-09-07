---
description: "面向部署方的 OpenTelemetry 会话遥测后端说明，用于选择模式、配置导出器或排查哪些数据离开本机。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

[English](README.md) | 中文

## 概述

`dsh-session-telemetry-otel` 仅在新的显式反馈后通过 OTel JS SDK 导出会话记录，适用于所有用户和提供方，包括 `deepseek-official`。`FEEDBACK_ONLY` 释放截至该反馈的权威日志前缀，包含上下文；后续记录等待下一次显式反馈。`DISABLED` 不构造传输。SDK 批处理可完成已授权的上传，无需另一次用户交互或模型调用。部署方负责脱敏规则。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当部署方需要通过 OpenTelemetry 日志导出会话记录时挂载此插件。选择一个模式、给导出器一个端点，并决定是否在 seam 上挂载脱敏规则。

### 模式

| `mode` | 行为 |
|---|---|
| `FEEDBACK_ONLY` | 默认值。文本反馈、评分创建或修改、备注修改和撤回释放尚未交接的前缀，截止该权威反馈事件；后续记录等待 |
| `DISABLED` | 不构造协调器、提供方、处理器或导出器；没有遥测记录离开进程。活跃会话反馈在本地告警；冷会话修改保持静默 |

程序化 TypeScript 配置使用导出的 `SessionTelemetryMode` 枚举；原始字符串字面量不可赋值。`FULL` 会被拒绝，不是别名。[`sharing` 属性](../session-telemetry/README.zh.md#the-sharing-disclosure)报告 `feedback-only` 或 `disabled`，不代表投递回执。`/feedback` 确认文本只确认记录。

### 最小配置

上传模式需要导出器 URL，并原样接受 SDK 选项块：

```yaml
- id: sessionTelemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: FEEDBACK_ONLY       # optional; defaults to FEEDBACK_ONLY
    shutdownTimeoutMillis: 3000 # optional; defaults to 3000
    exporter:                # passed verbatim to the SDK's OTLP/HTTP log exporter
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; passed verbatim to BatchLogRecordProcessor
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `FEEDBACK_ONLY` | 共享策略：`FEEDBACK_ONLY` 或 `DISABLED` |
| `exporter.url` | 上传模式必填 | 完整 OTLP 日志端点；必须能解析为 `http(s)` |
| `exporter`、`processor` | — | 原样传给 SDK 导出器与批处理器 |
| `shutdownTimeoutMillis` | `3,000` | SDK 完整关闭序列的外层截止时间 |

直接调用 `ctx.sessionTelemetry.emit()` 在任何模式下都是空操作，不能绕过反馈授权。继承的父会话反馈不授权子会话导出：子会话需要新的自身反馈。授权后的前缀包含继承的上下文。

模型请求、请求头、Session 创建或接纳、恢复，以及插件挂载或 HMR（热模块替换） 均不授权捕获。仅有存储的反馈不会触发任何上传。SDK 定时刷新和关闭可以完成先前已授权的批次，但绝不捕获新记录。

### 哪些数据会离开本机

在上传模式中，记录携带 seam 的 `sessionTelemetry/record` waterfall 返回的完整 `event.data`——消息内容、工具参数与结果、系统提示词与工具 schema、todo 文本、压缩（compaction）摘要、反馈文本，以及会话 `cwd`。提供方凭据绝不会出现：适配器的 API key 是构造函数参数而非会话事件，因此它们在结构上就不存在于日志中，也就不存在于遥测中。`DISABLED` 不构造 SDK 流水线，也不把任何捕获内容交给后端。

### 失败与关闭

配置错误会在插件加载时失败：缺少或非 `http(s)` 的 `exporter.url`、非正整数的 `processor.maxExportBatchSize`（SDK 会接受该值，随后却在关闭时挂起）以及无效的 `shutdownTimeoutMillis` 都会在任何记录导出前被拒绝。关闭期间，OTel 会先等待 `exporter.forceFlush()`，再等待处理器有界完成 promise；如果该传输 promise 始终不结算，本包会在 `shutdownTimeoutMillis` 到期时放弃等待、记录已隔离的失败，并让应用继续拆卸——届时仍待处理的记录可能在进程退出时丢失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端的组合方式；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端是对 OTel JS SDK 的薄适配层：它拥有反馈授权、资源身份与外层关闭截止时间。权威 ledger 记录使用 `@deepseek-ai/dsh-session-telemetry-otel` 插桩作用域；此后端不捕获运维记录。资源身份携带 `service.name`/`service.version`（来自 `dsh-llm` 的 `APP_IDENTITY`）以及匿名 `user.id`（来自 `$DSH_HOME/.anonymous-user-id`），按导出批次携带一次，而非逐条记录。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：模式解析、fail-closed 校验、SDK 流水线接线、协调器组装、关闭截止时间 |

### 捕获接线

后端使用包含存储历史的按需捕获。只有新的自身 `feedback/record`、`feedback/message-put` 或 `feedback/message-delete` 事件触发活跃会话捕获，并以该事件为上限。冷会话 `feedback/committed` 通知提供已提交的权威快照，不发布存活 Session 或 Agent。同对象交接游标抑制重复捕获。后端不实现 `flush()`；SDK 负责批处理和关闭排空。

### 字段映射

每条遥测记录映射为一条 SDK 日志记录，携带捕获的时间戳、严重级别、正文和属性。反馈授权的是尚未交接的完整前缀，而非只有反馈载荷。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当后端约定不够用时阅读以下页面。它们从它所实现的 seam 逐步进入子系统参考与它所上报的身份。

- [会话遥测 seam](../session-telemetry/README.zh.md)——捕获约定、记录词汇与脱敏 waterfall。
- [会话遥测子系统](../../../docs/subsystems/session-telemetry.zh.md)——能力拆分与类型声明。
- [匿名用户身份](../../identity/anonymous-user-id/README.zh.md)——作为 OTel Resource `user.id` 上报的 id。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-telemetry-otel)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该后端把 seam 记录转发进 OTel SDK 流水线，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 SDK 行为在何处起主导作用、导出保证止于何处。它们是当前包约束。

- **上游实验性源码树**——`@opentelemetry/sdk-logs` 从上游实验性源码树发布；SDK API 的变动只会落在本包，也仅落在本包，而 seam 约定不动。
- **真实 collector 行为属于 SDK 导出器**——身份验证、TLS、限流及其他真实 OTLP 部署行为遵循上游 SDK，不由本包自有兼容层处理。
- **尽力交接**——新冷快照以及重启后的新反馈提交可能重复前缀；接收方按 Session id、格式版本和事件 seq 去重。没有持久化 outbox、投递水位、自动重试承诺或采集端接受保证。OTel 与需显式启用的 DeepSeek API 路径可能重叠。撤回导出删除事件，不是远端擦除。

- **后端可用性**——本插件禁用或卸载期间提交的反馈会记录在本地，但恢复插件不会自动重放。捕获要求订阅方保持挂载直到观察到提交；在冷写入尚未完成时卸载，可能错过其 flush 后通知。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。mode 只改变 capture handoff、SDK setup 与本地 diagnostics，不改变可由独立 companion 对照的 Session 或 service 状态。
