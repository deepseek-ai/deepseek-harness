---
description: "在权威 Session 日志中保存已完成 assistant 消息的评分与备注。"
kind: "package-reference"
---

# @deepseek-ai/dsh-message-feedback

[English](README.md) | 中文

## 概述

本服务为已完成的 assistant 消息记录好评、差评及可选的原样备注。每次创建、编辑和删除都由权威 Session 日志保存；`list`、`put` 和 `delete` 提供当前反馈，不会构造或唤醒 Agent。反馈仅写入日志，不进入模型历史。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将 `dsh-message-feedback` 与 `sessions`、`sessionPersistence` 一起挂载。它不需要 storage-domain 服务。Web 组合提供浏览器消费方，并将备注上限设为 8192 字节。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxNoteBytes` | 必填 | 单条可选备注的 UTF-8 字节上限，必须为正安全整数。 |

提交的备注必须包含非空白字符，且不超过配置的字节上限。空白备注返回 `note-blank`；过长备注返回 `note-too-large`。通过校验的文本会完整保留，包括首尾空白。省略备注会清除它。备注校验先于 Session 查找。

### 读取与修改反馈

| 操作 | 请求 | 成功 | 业务失败 |
|---|---|---|---|
| `list` | Session id | 按创建顺序返回当前条目 | Session 不存在 |
| `put` | Session、消息、评分、可选备注、预期版本 | 当前条目 | Session 或目标不存在、版本冲突、备注无效 |
| `delete` | Session、消息、预期版本 | 条目不存在 | Session 不存在、版本冲突 |

创建时传入 `ifVersion: null`；编辑或删除时使用返回的版本。陈旧修改返回 `version-conflict` 及当前条目。每次实质 put 都生成新 token，并保留原始创建时间。匹配的无变化 put 返回相同条目，不追加事件。删除不存在的条目始终成功，不受所传版本影响，也不追加事件。重新创建已删除条目会产生新的创建时间和排序位置。

目标必须是由 append 来源事件产生的非空 assistant 消息。用户消息、空 assistant 占位及 replacement 来源消息返回 `target-not-found`。反馈跨重启保留；fork 即使继承了包含父会话反馈的前缀，也从没有自有反馈开始。

<a id="understand-the-implementation"></a>
## 理解实现

### 权威日志与持久性

`feedback/message-put` 保存所属 Session id 及完整条目，包括版本和时间戳。`feedback/message-delete` 保存所属 Session 和消息 id。当前状态从这些事件推导，忽略属于其他 Session 的事件。持久化 payload 在使用前经过校验。不存在第二个反馈存储或缓存。

活跃会话通过 `Session.append` 追加，并等待 `sessions.flush`，然后通过持久化读 handle 核实捕获的日志末端与 Session header，才会报告成功。冷会话修改在读取、校验、比较、追加、flush 和关闭期间持有持久化写 handle。冷读取使用读 handle。两条路径都不会构造 Session 或追加生命周期事件。

每个 Session 的队列在同一服务实例内串行化操作；持久化写 handle 排除其他冷写入方。销毁时停止接收操作并排空已接收操作，然后释放服务。持久化故障会 reject，而非变成业务失败。flush 失败不会回滚已接受的事件；调用方可以读取并使用其版本重试。成功的无变化修改也会 flush 当前前缀。

冷会话的实质修改在 flush 后通过 `feedback/committed` 通知借用的只读权威日志前缀；观察方在转移所有权前必须深拷贝。观察方在写入所有权释放前完成，不得等待同一 Session 的其他反馈操作，也不能使已提交的修改失败。活跃会话消费方观察 `session/event`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote 服务、payload 校验、事件投影与持久化所有权 |
| [`src/types.ts`](src/types.ts) | 请求、结果和 Session 事件声明；仅类型 |

不发布运行时不变式伴生入口：服务直接从校验后的权威事件推导反馈，不持有可独立修改的投影。

各自的 API 见[反馈子系统](../../../docs/subsystems/feedback.zh.md)、[Session 持久化](../../../docs/subsystems/persistence.zh.md)和[浏览器消费方](../../client/ui-message-feedback/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 消息反馈

#### 模型看到什么

无。`feedback/message-put` 和 `feedback/message-delete` 不携带 surface 位置、工具、提示词段落或模型可见上下文。日志导出与投递策略由相应消费方负责。

#### Token 影响

为零。评分、备注和服务结果不进入模型请求。

#### KV Cache 影响

相互独立。反馈不改变模型请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅日志具有权威性：**不读取或迁移现有 `message_feedback` 伴随数据。这些文件保持不变，但其反馈无法通过本服务访问。
- **删除保留历史：**delete 移除当前反馈，不会从只追加日志中清除更早的评分或备注；它不是隐私擦除操作。
- **写入所有权：**另一个进程持有 Session 写 handle 时，冷会话修改会 reject。服务不会唤醒该所有者，也不协调跨进程 Remote 调用。
- **受信任调用方：**请求不包含经过认证的 actor 或审计身份。部署方必须保护 Host gateway。
- **遥测导出：**对于所有用户和提供方，包括 `deepseek-official`，随附 OTel 后端在 `FEEDBACK_ONLY` 模式下仅在新的显式文本反馈、评分或备注编辑、撤回后释放完整权威日志前缀。前缀包含上下文和原样备注；后续记录等待下一次反馈，`DISABLED` 阻止捕获。部署方负责脱敏；见 [OTel 导出策略](../../session/session-telemetry-otel/README.zh.md)。
- **扫描成本：**每次访问已有 Session 的 `list`、`put` 或 `delete` 都会扫描完整事件日志来推导当前反馈；冷会话操作还会从持久化存储读取完整日志。工作量随 Session 历史总量增长，而不只是反馈条目数。
- **保留量：**`maxNoteBytes` 只限制单条备注，不限制日志总大小或修改次数。

<a id="dev-note"></a>
### 开发备注

[包测试](tests/message-feedback.spec.ts)覆盖当前状态与持久历史语义；[Loader 组合](tests/loader-composition.spec.ts)验证跨重启的活跃和冷 JSONL 操作。
