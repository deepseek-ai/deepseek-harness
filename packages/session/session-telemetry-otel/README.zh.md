---
description: "面向部署方的 OpenTelemetry 会话遥测后端说明，用于选择模式、配置导出器或排查哪些数据离开本机。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

[English](README.md) | 中文

## 概述

适配器注入 `otel`；[共享 OTel 插件](../../telemetry/otel/README.zh.md) 创建其独立 Session 日志通道。授权、脱敏、身份、scope 版本、配置和关闭期限仍由本包负责。

`dsh-session-telemetry-otel` 仅在新的显式反馈后通过 OTel JS SDK 导出会话记录，适用于所有用户和提供方，包括 `deepseek-official`。`FEEDBACK_ONLY` 释放截至该反馈的权威日志前缀，包含上下文；后续记录等待下一次显式反馈。`DISABLED` 不构造传输。定时批处理可完成已授权的上传，无需另一次用户交互或模型调用。部署方负责脱敏规则。

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

启用上传的模式必须提供 exporter URL。processor 设置控制独立的 Session 日志队列；路由头通过 `exporter.headers` 显式配置。

```yaml
- id: sessionTelemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: FEEDBACK_ONLY       # optional; defaults to FEEDBACK_ONLY
    shutdownTimeoutMillis: 3000 # optional; defaults to 3000
    exporter:                # explicit SDK transport settings
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; byte/count batching and per-request watchdog
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `FEEDBACK_ONLY` | 共享策略：`FEEDBACK_ONLY` 或 `DISABLED` |
| `exporter.url` | 上传模式必填 | 完整 OTLP 日志端点；必须能解析为 `http(s)` |
| `exporter`, `processor` | — | SDK 传输及字节/条数聚合；不继承环境中的头部和 TLS 身份。agent 工厂负责返回实例的设置，包括 keepAlive |
| `shutdownTimeoutMillis` | `3,000` | 所有排队 HTTP 请求的外层期限；到期后停止剩余排队发送 |
| `maxRequestBytes` | `4,000,000` | gzip 前完整 OTLP JSON 请求的最大字节数；只能调低 |

直接调用 `ctx.sessionTelemetry.emit()` 在任何模式下都是空操作，不能绕过反馈授权。继承的父会话反馈不授权子会话导出：子会话需要新的自身反馈。授权后的前缀包含继承的上下文。

模型请求、请求头、Session 创建或接纳、恢复，以及插件挂载或 HMR（热模块替换）均不授权捕获。仅凭已存储的反馈不会触发任何操作。定时刷新和关闭可以完成先前已授权的批次，但绝不捕获新记录。

### 哪些数据会离开本机

每条 Session 事件对应一个 `eventName: "session-log"` 记录。`attributes.sessionId` 是 collector 使用的 Session 身份；`attributes.content` 编码完整事件 envelope 和脱敏后的 `event.data`。保留的是 JSON 值，不保证原 JSONL 字节或键顺序相同。为现有消费者保留 `session.id`、`event.seq` 和 `event.type` 元数据。Resource 携带应用和匿名用户身份；scope 携带后端包名和版本。基础配置使用 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`，可用 `DSH_TELEMETRY_OTLP_URL` 覆盖。不隐式添加 channel 头。

共享 OTel 通道使用 SDK 的 OTLP JSON 序列化器对每条记录计量一次，包含其 resource/scope envelope，再按保守大小顺序组包。单条超限事件产生一次拒绝诊断且不截断。Session 日志不会与产品埋点混在一个请求中。捕获交接和关闭完成不代表 collector 确认。

### 失败与关闭

无效字节上限、非正队列/计时值、`maxExportBatchSize > maxQueueSize`、无效 endpoint 或关闭期限在加载时失败。processor 默认队列为 2,048 条、单请求最多 512 条、调度延迟 1,000 ms、请求监测期限 30,000 ms。字节上限可能将按条数划分的批次拆成多个串行 HTTP 请求。每个请求在回调后等待 SDK 导出队列清理完成，才启动下一个请求。`exportTimeoutMillis` 针对每个请求告警，但不会释放未结束的传输槽位；SDK transport 负责网络超时和重试。关闭时发送这些请求直到 `shutdownTimeoutMillis`，到期后丢弃剩余队列并禁止后续发送，在途请求仍可能结束。因此较大的授权前缀在 CLI 退出时可能只发送了一部分。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端的组合方式；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端负责反馈授权、身份和关闭。共享 OTel 服务负责通道创建、字节和条数调度、记录构造、JSON 传输、压缩与重试。Resource 身份携带 `APP_IDENTITY` 中的 `service.name` / `service.version` 以及匿名 `user.id`；scope 保留本包的名称和版本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：模式解析、fail-closed 校验、SDK 流水线接线、协调器组装、关闭截止时间 |

### 捕获接线

后端按需捕获历史，由新的自身反馈事件或已提交的冷会话快照触发。私有 reporter 串行发送排队 HTTP 请求，即使监测期限已触发也不会重叠；外层关闭期限停止剩余队列。不额外暴露 flush 入口。

### 字段映射

每条采集记录向 `SessionLogReporter` 提供单独复制的事件信封和脱敏后的载荷；序列化保留可选的呈现元数据及事件序号和时间。反馈授权整个尚未交接的前缀，而不只是反馈载荷。

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

**运行时不变式：** 不发布伴生入口。模式选择只改变 capture handoff、SDK setup 与本地 diagnostics，不改变可由独立 companion 对照的会话或服务状态。无法根据本地队列状态推断 collector 是否收到记录。
