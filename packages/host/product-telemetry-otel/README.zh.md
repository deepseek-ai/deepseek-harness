---
description: "配置显式产品使用事件、OTLP/HTTP 路由、批量发送与退出等待上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-product-telemetry-otel

[English](README.md) | 中文

## 概述

将选定的产品使用事件发送到 OTLP/HTTP 接收服务。事件包含名称、字符串摘要、发生时间，以及标量或单层对象属性。挂载插件不会自动采集信息；应用需要显式提交每个事件。发送采用尽力而为方式，不代表数据已入仓。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Cordis 组合中挂载插件并提供应用标识；需要时可覆盖接收地址。桌面组合在开启[产品埋点](../../client/product-analytics/README.zh.md)时挂载本插件；普通 Web 不挂载。下方独立示例读取 `DSH_APP_VERSION`；桌面端由原生启动器提供 `DSH_CLIENT_VERSION`。两者均须为运行中的发布版本；缺少版本时 schema 会拒绝配置。

```yaml
- name: '@deepseek-ai/dsh-otel'
- name: '@deepseek-ai/dsh-host-product-telemetry-otel'
  config:
    endpoint: https://dsh-otel-collector.deepseeksvc.com/v1/logs
    serviceName: deepseek-harness
    serviceVersion: !!js process.env.DSH_APP_VERSION
    compression: gzip
    scheduledDelayMillis: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | 完整 HTTP(S) 日志地址 |
| `serviceName`, `serviceVersion` | 必填 | OTel resource 中的应用标识 |
| `channel` | `dsh_otel_report` | 接收服务的 `x-channel` 请求头 |
| `compression` | SDK 环境变量 | `gzip` 或 `none`；省略时遵循 OTel 压缩环境变量 |
| `maxExportBatchSize`, `maxQueueSize` | `512`, `2048` | 记录条数上限；批次大小不能超过队列大小 |
| `scheduledDelayMillis` | `30000` | 不满批次时的发送间隔 |
| `timeoutMillis` | `15000` | Exporter HTTP 发送与重试的超时时间 |
| `exportTimeoutMillis` | `20000` | Processor 批次导出的超时时间 |
| `shutdownTimeoutMillis` | `21000` | 排空期限；超时取消待完成的导出并提示可能丢失数据 |

默认接收地址将显式提交的事件发送到生产产品 collector，测试和自定义部署必须覆盖该地址。只向 collector 发送 `x-channel` 和 SDK 协议请求头，不继承宿主 OTel 请求头或客户端证书。

30 秒间隔用于批量发送产品事件；exporter 的 15 秒重试窗口位于 processor 的 20 秒批次期限内。21 秒排空期限覆盖 processor 期限未覆盖的 SDK `forceFlush()`。超时会取消活动 HTTP 请求和重试等待，随后等待传输清理完成才结束卸载。collector 不可达时，卸载可能等待完整的 21 秒。2,048 条满队列需要四个 512 条批次，可能无法在期限前排空。要求更快退出的交互式应用组合应覆盖这些时间配置；两种配置都不保证送达。

消费方注入 `productTelemetry`，调用 `emit()` 提交明确选定的分析字段。事件名称与字段含义由产品和数据分析负责人定义。插件不读取 Session、账号、凭证或设备标识。调用方必须排除提示词、回答、文件内容、凭证及其他未经批准的数据。

接收服务要求 body 为字符串，attributes 的值为字符串、数字、布尔值或由这些标量组成的对象。调用方以毫秒提供发生时间；插件填写观测时间，默认严重程度为 INFO。无效传输配置在激活时报错。发送失败产生本地警告，事件提交不等待网络。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

适配器注入 `otel`，通过 `ctx.otel.createEventReporter()` 创建独立的普通事件通道。[共享 OTel 插件](../../telemetry/otel/README.zh.md) 负责传输和 SDK 聚合；本适配器负责埋点配置及关闭取消期限。不安装全局 OTel provider。

[`src/index.ts`](src/index.ts) 负责配置与提交。不发布运行时不变量伴随模块：本地没有独立的送达确认可与 SDK 队列比较。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [产品埋点](../../../docs/subsystems/product-telemetry.zh.md)——消费方类型与服务参考。
- [会话上报](../../session/session-telemetry-otel/README.zh.md)——独立的、由反馈授权的 Session 上报。
- [测试策略](../../../docs/testing.zh.md)——Loader 组合与网络测试夹具。

-----

<a id="model-experience"></a>
## 模型体验

无，因为插件仅发送显式分析记录，不提供模型上下文。

#### KV Cache 影响

无；提交事件不会改变模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

发送和采集受以下能力限制。

- 调用方拥有事件选择、渲染进程到宿主的传输以及获准使用的标识属性。
- 队列仅存在于内存；队列溢出、网络故障和进程退出可能丢失事件。没有持久发件箱或入仓确认。
- SDK 按记录条数而非编码字节数分批。调用方必须确保记录不超过接收服务的 4 MB 限制，并选择接收服务适用的批次大小。
- 不自动脱敏调用方选择的字符串。本包不决定产品告知或同意策略。

<a id="dev-note"></a>
### 开发备注

无。
