---
description: "通过共享 Cordis OTel 服务创建独立的 OTLP 上报通道。"
kind: "package-reference"
---

# @deepseek-ai/dsh-otel

[English](README.md) | 中文

## 概述

挂载一个 `otel` 服务即可创建普通事件和 Session 日志上报通道。每个通道拥有独立的 exporter、resource、instrumentation scope 和队列。仅挂载不会创建传输、身份或发送数据。业务调用方负责授权、脱敏、字段选择及通道销毁。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

base bundle 挂载 `@deepseek-ai/dsh-otel`。独立组合必须在注入 `otel` 的调用方之前挂载它。普通埋点调用 `ctx.otel.createEventReporter(options)`，完整 Session 事件调用 `ctx.otel.createSessionLogReporter(options)`。选项显式提供 endpoint、scope、resource attributes、队列设置和诊断回调；服务本身没有部署默认值或自动采集策略。

返回的通道由调用方持有。普通事件 `shutdown(signal)` 在传入信号中止时取消请求和重试等待，并在传输清理完成后返回。将关闭注册到调用方的 Cordis fiber，并用配置的期限约束完整清空过程。注入机制使服务替换时卸载依赖方。调用方卸载后不得继续保留通道。产品和 Session 适配器为 UI 和反馈调用方实现这些职责。

普通通道使用 SDK 按条数聚合。Session 通道将每条完整事件保留为一个记录，包含 `eventName: "session-log"`、`sessionId` 和 JSON 字符串 `content`，并保证未压缩请求不超过 4,000,000 字节。字节限制、单条拒绝、串行传输结束和关闭行为见 [Session 适配器](../../session/session-telemetry-otel/README.zh.md)。Session 通道不会与普通事件共享请求或队列。

Header 显式提供。服务不会附加 channel header，也不继承环境中的授权 header 或 TLS 身份。Agent factory 配置返回的 agent，包括 keepAlive。普通事件通道在关闭时销毁自己的 agent；factory 必须为每个通道提供独立 agent。每个调用方提供 scope 名称和版本，因此共享传输不会改变事件归属。

<a id="understand-the-implementation"></a>
## 理解实现

`src/index.ts` 注册服务；`event-log.ts` 负责普通事件的 SDK 聚合；`session-log.ts` 负责字节和条数调度；`transport.ts` 提供 Session 的 SDK JSON HTTP delegate；`event-transport.ts` 使用 Got 实现可取消的普通事件 HTTP 请求和重试等待，序列化与导出计数仍由 SDK 负责。不安装全局 OTel provider。Session processor 对每条记录只计量一次，按保守大小组包，并在每次回调后等待 SDK 并发队列清理完成才发送下一请求。

不发布运行时不变式伴生入口：通道创建不注册独立领域状态，无法从本地队列推断 collector 是否收到记录。组合测试覆盖独立通道和服务移除；适配器测试覆盖依赖 fiber 清理与反馈授权。

<a id="further-exploration"></a>
## 进一步探索

- [OTel 子系统](../../../docs/subsystems/otel.zh.md) — 服务职责与 API。
- [产品适配器](../../host/product-telemetry-otel/README.zh.md) — 显式埋点策略与配置。
- [Session 适配器](../../session/session-telemetry-otel/README.zh.md) — 反馈授权和上传限制配置。

<a id="model-experience"></a>
## 模型体验

无，因为服务只投递调用方选择的记录，不改变模型上下文。

#### KV Cache 影响

无；上报不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

通道提供尽力而为的纯内存投递，具有以下限制。

- 调用方负责同意、脱敏、resource 身份、renderer 到 host 的 RPC 及外层关闭期限。
- 队列溢出、Session 事件超限、传输失败和进程退出可能丢失记录。不提供持久 outbox 或仓库确认。
- 普通事件通道按条数聚合；调用方必须选择适合 collector 的事件和批次大小。

<a id="dev-note"></a>
### 开发备注

无。
