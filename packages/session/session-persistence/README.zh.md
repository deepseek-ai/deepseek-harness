---
description: "面向用户与维护者的持久会话存储 seam 说明，用于选择持久化后端、恢复会话，或按共享服务约定构建后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence

[English](README.md) | 中文

## 概述

`dsh-session-persistence` 通过后端无关的 `ctx.sessionPersistence` 服务持久存储会话的事件日志、在恢复时重新加载并列出已存储会话。持久化单元就是现有 `SessionEvent` 日志——不存在另一套并行的存储消息类型——不可回放的元数据（格式版本、工作目录、血缘、种子边界）作为 `SessionHeader` 单独传输。后端拥有自己的存储，而服务拥有仅追加日志、连续序列号、保留中断轮次而非截断的崩溃恢复，以及只在批次安全后才返回的持久写入。随产品交付的 JSONL provider 用每个 Session 一份产物实现该服务；第三方 provider 可以实现同一约定，而不改变 loop 或模型。

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

挂载一个持久化后端即可让会话持久化。后端把自己注册为 `ctx.sessionPersistence`；组合中的其他部分不变——loop、恢复与回放调用的是同一个服务。

### 选择后端

seam 随产品交付 [JSONL](../session-persistence-jsonl/README.zh.md) 后端。它把每个 Session 存为一份仅追加 `.jsonl.zstd` 产物，并由 `locate(meta)` 返回绝对路径。第三方后端可以直接实现该服务；必须遵守的[后端约定](#understand-the-implementation)见下文。

### 服务提供什么

挂载后端后，你可以持久存储会话事件、重新加载已存储日志并列出已存储内容：

```text
await ctx.sessionPersistence.create(meta)                  // register a session
await ctx.sessionPersistence.ensureMaterialized(session)   // persist an empty resumable session
await ctx.sessionPersistence.append(id, events)            // durably persist a batch
const { meta, events } = await ctx.sessionPersistence.load(id)   // reload on resume
const headers = await ctx.sessionPersistence.list()        // every stored session
```

`append` 只在批次持久后返回，因此成功返回的写入在操作系统崩溃或断电后依然存在。普通 `create` 保持惰性；只有当空会话本身必须出现在持久列表中时，生命周期前端才调用 `ensureMaterialized`，且不会虚构事件。`load` 返回不可变的平衡日志并提交任何需要的崩溃恢复；`inspect` 读取同一视图但不提交恢复。从水位恢复的消费方可以只读取该序列号及之后的已存储事件，会话的产物位置（`locate`）不经文件系统 I/O 即可解析。

### 恢复与崩溃恢复

恢复就是 `load` 加会话准备：存储日志连同其头部血缘一起返回，因此恢复后的 agent（智能体）看到相同的历史与组装。中途崩溃的会话重新加载时，其被中断的最终轮次会保留并保持平衡：`load` 为未获回答的调用追加合成 `tool/result` 与 `turn/end {interrupted}` closer，而不是丢弃事件——单个轮次可能很大，而这些事件在崩溃前已持久写入。只有从未完整写入的撕裂尾部碎片会被丢弃。

### 失败与恢复

当前构建无法忠实解读的存储日志会以方向感知的错误被拒绝，绝不错读。`SESSION_FORMAT_VERSION` 保持 v0，本构建不提供格式迁移路径；更高版本会要求操作者升级 harness。解码器只接受下文点名的有限同版本记录变体。本构建不认识的事件类型会被拒绝，除非其信封标记为 `ignorable`；已提交前缀中的损坏以 `SessionPersistenceCorruptionError` 拒绝。对仍绑定到活动会话的 id 执行 `load`，会先刷新其快照并在轮次开放时拒绝；冷 load 应用恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明 seam 如何实现持久存储以及后端如何接入；可观察约定见[使用本包](#use-this-package)与生成的 [Cordis API](../../../docs/subsystems/persistence.zh.md#cordis-surface)。

### 设计理念

本包是能力 seam 的 Service Definition，分两半。抽象的 `SessionPersistence` 服务是公开约定；`PersistenceCoordinator` 为缓冲、串行化、物化、修复、接管与完全停稳的 dispose 提供后端无关编排。JSONL provider 实现存储读取、追加、修复与列出所需的小型持久原语；第三方 provider 可以复用同一 coordinator，也可以直接实现该服务。

### 每个后端必须遵守的不变量

- **仅追加；崩溃轮次会被关闭，而非截断。** 已 flush 事件绝不重写；`load` 保留中断的最终轮次并持久追加合成 closer。
- **连续 `seq`。** 日志中间的缺口会被拒绝；`append` 的第一个 `seq` 必须等于已存储 next-seq。
- **无损 JSON 数据。** 批次经过共享单遍无损 JSON 边界；无法序列化的载荷在 append 处被拒绝。
- **持久性。** `append` 只在批次持久后返回。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `SessionPersistence` 服务与重新导出的元数据类型 |
| [`src/coordinator.ts`](src/coordinator.ts) | 共享写入编排：批处理、串行化、修复、接管、dispose、格式拒绝 |
| [`src/write-behind.ts`](src/write-behind.ts) | 每会话有界写入控制器与 flush 屏障 |
| [`src/preparations.ts`](src/preparations.ts) | 为恢复复用而有界保留的未发布 Session 准备结果 |
| [`src/revision.ts`](src/revision.ts) | 带品牌类型的不透明修订值 token |
| — | 不发布运行时不变式伴生入口；协调器断言存储/活动身份与 cwd。 |

### 写入路径概览

每个 `session/event` 把事件复制到其会话的 controller。第一个待处理事件开启固定批处理窗口；后续事件加入但不重置截止时间。窗口到期后启动一次持久追加；该次写入期间接纳的事件形成另一个独立有界的后续批次。`session/flush` 取消等待并排空至完全停稳，因此 loop 在下一轮次前把它用作排序与错误观察检查点。被拒绝的后台写入保留其事件并暂停自动重试；新事件开启新窗口，而显式 flush 或后端拆卸会立即重试。

### 存储记录兼容

后端读取只会在校验当前记录之前，规范化明确支持的 v0 记录变体。协调器对 `load`、`inspect`、`readFrom`、无所有者状态认领与 HMR 接管使用同一份规范化视图。读取不会重写已存记录，后续追加使用当前 v0。[消息标识机制引入前的消息](../../../.agents/notes/implemented/bug-fix/2026-07-28-load-pre-identity-session-messages.zh.md)与 [react-loop 引入前会话](../../../.agents/notes/implemented/bug-fix/2026-08-04-load-pre-react-loop-sessions.zh.md)笔记规定这些有限例外；它们不构成通用格式迁移承诺。

</details>
-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享持久性模型逐步进入随产品交付的后端与决策证据。

- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——完整服务约定、flush 检查点、崩溃恢复与生成的 Cordis API。
- [JSONL 持久化后端](../session-persistence-jsonl/README.zh.md)——随产品交付、按会话存储文件的后端。
- [会话检查点策略](../session-checkpoint-policy/README.zh.md)——在语义边界上经由本服务刷新的插件。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

seam 不添加提示词或 schema。恢复会将已存储的表层事件还原为消息历史；已存储请求 header 重建较早调用，新 loop 则为下一次请求组合当前系统提示词、工具与会话前缀。崩溃修复将没有持久调用的 assistant 请求标记为 `TOOL_NOT_STARTED`；有持久调用但无结果时变为 `TOOL_OUTCOME_UNKNOWN`，其文本允许模型重试只读或幂等工作，但要求验证副作用或询问用户，而不是盲目重试。

#### Token 影响

普通持久化期间为零 token。恢复后会重新计入保留历史的 token 用量，并照常计入当前请求 envelope 的 token 用量；每个已修复调用都会增加一段以引用形式保留的错误文本。

#### KV Cache 影响

持久化不修改实时请求前缀。只有当重建历史、当前 envelope 与模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加，不重写较早历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定 seam 保证的终点。它们是当前包约束，不是任务积压。

- **无删除或保留接口**——剪枝已存储会话属于带外后端维护。
- **`list()` 无分页且无过滤**——它返回每个已存储会话的 header；适合本地存储，大规模时无索引。
- **合成 closer 是唯一崩溃方案**——后端必须在 load 时合成 `tool/result`/`step/end`/`turn/end` closer；没有继续中断轮次而不先关闭它的部分轮次恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
