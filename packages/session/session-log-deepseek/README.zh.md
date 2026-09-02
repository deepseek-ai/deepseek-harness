---
description: "面向启用官方 DeepSeek 请求元数据的部署，说明规范会话日志的增量上传。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-deepseek

[English](README.md) | 中文

## 概述

用于 DeepSeek 官方 LLM API 请求的增量权威会话日志上传。该函数插件注入 `ctx.sessions` 与 `ctx.deepseekLlmApiExtensions`，并拥有 `dsh_session_log` 请求字段以及用于派生接受水位的持久 `session-log-deepseek/delivery-accepted` 事件。仅当官方 API 需要接收 Session 日志后缀时才启用它。

## 目录

- [配置](#configuration)
- [请求字段](#request-field)
- [接受与重试](#acceptance-and-retry)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---:|---|
| `enabled` | `false` | 注册 `dsh_session_log` 贡献。将其设为 `true` 可选择启用会话日志上传。 |

随附 profile 会挂载该插件，让 overlay 可以启用它；默认配置不会注册请求字段，也不会追加接受水位。

<a id="request-field"></a>
## 请求字段

对于携带存活 `sessionId` 的请求，插件会折叠该确切会话身份的最大已接受水位，对 `Session.events` 取快照，并发送水位之后的连续后缀。进程内 fold 会让每条事件只被扫描一次并增量消费后续追加；重启与 HMR 会从持久日志重建它。版本 1 字段包含兼容 v0 的原始会话 header（仅 seeded Session 携带 `seedLength`）、数值型 `afterSeq` 与 `throughSeq`，以及把完整权威事件翻译为原始数值 envelope 字段后的数组元素。每个水位都会记录已接受请求发送的会话 id，因此 fork 会话会忽略从父会话继承的水位。

<a id="acceptance-and-retry"></a>
## 接受与重试

DeepSeek 适配器会在 HTTP 2xx 后、消费 SSE（Server-Sent Events）正文前调用已准备贡献的 `accept()`。接受操作会追加 `session-log-deepseek/delivery-accepted` 及已上传的 `throughSeq`；下一次请求再把该事件作为新后缀的一部分上传。传输失败与非 2xx 失败不会追加接受记录，因此后续请求会重发不确定范围。并发交付可能乱序得到接受；折叠匹配记录中最大的 `throughSeq` 可以防止游标回退。

服务端接受后、持久化水位前发生崩溃，可能让恢复后的进程重放已经接受的范围。这是至少一次交付的失败方向：不确定性会制造重复，绝不会跳过序列。普通会话检查点策略会在下一个语义检查点持久化水位；本插件不执行独立 I/O。

缺少存活会话的直接请求会省略 `dsh_session_log`。普通 agent（智能体）、压缩（compaction）与会话标题调用都会携带存活会话 id。

<a id="model-experience"></a>
## 模型体验

### 会话日志元数据

#### 模型看到的内容

无。`dsh_session_log` 是 DeepSeek 请求中模型输入字段的同级字段，不会插入 `messages`、系统提示词或工具 schema。

#### Token 影响

模型输入 token 为零；该字段只会增加 HTTP 请求字节数。

#### KV Cache 影响

无；模型可见请求前缀保持不变。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **崩溃窗口重复**——2xx 后、接受水位持久化前进程丢失，会在恢复时触发保守重放。
- **缺少存活会话就没有字段**——直接调用或陈旧会话调用没有可供快照的权威日志；显式缺失语义仍暂缓处理。
- **没有独立请求大小上限**——完整交付会快速失败；提供方拒绝会保持游标不变，而非截断日志。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
