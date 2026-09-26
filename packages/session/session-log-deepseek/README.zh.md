---
description: "面向启用官方 DeepSeek 请求元数据的部署，增量上传规范会话日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-deepseek

[English](README.md) | 中文

## 概述

用于 DeepSeek 官方 LLM（大语言模型）API 请求的增量规范会话日志上传。该函数插件注入 `ctx.sessions` 与 `ctx.deepseekLlmApiExtensions`，并拥有 `dsh_session_log` 请求字段以及用于派生接受水位的持久 `session-log-deepseek/delivery-accepted` 事件。仅当官方 API 不得接收会话日志后缀时才禁用它。

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
| `enabled` | `true` | 注册 `dsh_session_log` 贡献。将其设为 `false` 可停止会话日志上传。 |
| `maxBytes` | 8 MiB | 单次请求携带的 `dsh_session_log` 字段序列化后的最大 UTF-8 字节数。 |

随附 profile 会挂载该插件，因此默认配置会注册请求字段并追加接受水位；overlay 可用 `enabled: false` 选择退出。

<a id="request-field"></a>
## 请求字段

对于携带存活 `sessionId` 的请求，插件会折叠该确切会话格式代的最大已接受水位，对 `Session.events` 取快照，并发送水位之后能放进 `maxBytes` 的最长连续事件段。进程内 fold 会让每条事件只被扫描一次并增量消费后续追加；重启与 HMR（热模块替换）会从持久日志重建它。版本 1 字段包含 `sessionFormatVersion`、原始会话 header（仅 seeded Session 携带 `seedLength`）、数值型 `afterSeq` 与 `throughSeq`，以及每个已转换为原始数值 envelope 字段的完整规范事件。只有记录的会话 id 与格式代均匹配请求来源时水位才生效，因此 fork 会话会忽略从父会话继承的水位。表层事件必须携带 `surfaceOp`，替换范围使用数值型 `startSeq` 与 `endSeq`；仅 system、user 与 tool 事件可以携带 `sourceEventSeqs`。assistant 的提供方元数据保留在内嵌流中，只出现在日志中的事件不携带这两个元数据字段。

`maxBytes` 按 UTF-8 字节限制完整的序列化字段，包括 header 与数值型 envelope 字段。超过上限的积压会分多次已接受的请求补传，每次都从上一次的 `throughSeq` 之后继续。第一条待发事件本身就超过上限时，请求会省略 `dsh_session_log`，插件记录一条告警，水位停在该事件之前，直到 `maxBytes` 能容纳它。运行时根本无法序列化的超大事件也按同样方式处理，且任何 `maxBytes` 都无法容纳它。

<a id="acceptance-and-retry"></a>
## 接受与重试

DeepSeek 适配器会在 HTTP 2xx 后、消费 SSE（Server-Sent Events）正文前调用已准备贡献的 `accept()`。接受操作会追加 `session-log-deepseek/delivery-accepted`，其中包含已上传的 `throughSeq` 与 `sessionFormatVersion`；省略格式字段的记录表示 v0。下一次请求再把该事件作为新后缀的一部分上传。传输失败、非 2xx 失败，以及 DeepSeek 适配器在扩展字段序列化失败后不带扩展字段发出的请求，都不会追加接受记录，因此后续请求会重发不确定范围。并发交付可能乱序得到接受；折叠匹配记录中最大的 `throughSeq` 可以防止游标回退。

服务端接受后、持久化水位前发生崩溃，可能让恢复后的进程重放已经接受的范围。这是至少一次交付的失败方向：不确定性会制造重复，绝不会跳过序列。普通会话检查点策略会在下一个语义检查点持久化水位；本插件不执行独立 I/O。

缺少存活会话的直接请求会省略 `dsh_session_log`。普通 agent（智能体）、压缩（compaction）与会话标题调用都会携带存活会话 id。

<a id="model-experience"></a>
## 模型体验

### 会话日志元数据

#### 模型看到的内容

无。`dsh_session_log` 是 DeepSeek 请求中模型输入字段的同级字段，不会插入 `messages`、系统提示词或工具 schema。

#### Token 影响

模型输入 token 为零；该字段只会增加 HTTP 请求字节数，且受 `maxBytes` 限制。

#### KV Cache 影响

无；模型可见请求前缀保持不变。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **崩溃窗口重复**——2xx 后、接受水位持久化前进程终止，会在恢复时触发保守重放。
- **缺少存活会话就没有字段**——直接调用或陈旧会话调用没有可供快照的规范日志；显式缺失语义仍暂缓处理。
- **超限事件会让上传停住**——字段单独就超过 `maxBytes` 的事件不会发送，后续事件也排在它后面，直到上限调高；根本无法序列化的事件会一直阻塞上传。
- **提供方拒绝会让请求失败**——提供方因该字段拒绝请求时，模型请求失败，游标保持不变，而非截断日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
