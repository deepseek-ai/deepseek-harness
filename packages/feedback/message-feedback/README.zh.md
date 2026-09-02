---
description: "针对已完成 assistant 消息的逐消息评分与备注，供用户与维护者选择、组合或排查该反馈服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-message-feedback

[English](README.md) | 中文

## 概述

`dsh-message-feedback` 让产品界面提供逐消息反馈：用户可以把一条 assistant 消息标记为好评或差评，并可附上简短备注，评分会与该消息绑定。评分与会话一起保存，重启后依然存在，并且绝不会进入模型历史或遥测。产品界面通过 `messageFeedback` 服务读取、创建和修改评分，其 `list`、`put`、`delete` 三个操作就是全部对外表面。唯一需要部署方设置的项是备注最大长度（`maxNoteBytes`），Web 组合将其设为 8192。浏览器控件位于独立的客户端包中；本包提供服务本身。

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

当产品界面需要让用户对单条 assistant 消息评分或加备注时，选择此服务。反馈只绑定已完成的（即已发出的）消息，并且使用该服务绝不会启动或恢复 agent。自定义应用需要把此服务与会话持久化和存储一起挂载；随附的 Web 组合已用 `maxNoteBytes: 8192` 组合好全部组件。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxNoteBytes` | 必填 | 一条可选备注的最大 UTF-8 字节长度。 |

```yaml
- id: message-feedback
  name: '@deepseek-ai/dsh-message-feedback'
  config:
    maxNoteBytes: 8192
```

备注必须包含至少一个非空白字符，并且不得超过配置的字节长度；空白备注会以 `note-blank` 拒绝，超长备注会以 `note-too-large` 拒绝。通过校验的文本按提交原样存储——不做任何 trim。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-message-feedback)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 读取与修改反馈

调用方用三个操作读取和修改某个会话的反馈：

| 操作 | 请求 | 成功 | 拒绝时机 |
|---|---|---|---|
| `list` | 会话 id | 当前的评分与备注，按创建顺序 | 会话不存在 |
| `put` | 会话、消息、评分、可选备注、期望的 version | 已存储的评分与备注 | 会话不存在、消息不是有效目标、version 冲突、备注空白或超长 |
| `delete` | 会话、消息、期望的 version | 评分已不存在 | 会话不存在、version 冲突 |

每次修改都必须基于服务为该项评分返回的 version：基于更旧 version 的修改会以 `version-conflict` 拒绝，且回复携带当前评分，调用方无需再次读取即可看到变化。删除一条已经不存在的评分会成功；对不同消息的并发修改互不冲突。省略 `note` 会清除已有备注。

### 可以对什么评分

评分绑定一条已完成的 assistant 消息：消息必须存在，并且是发送过的 assistant 消息。用户消息、空的 assistant 占位与已被替换的消息都不是有效目标，会以 `target-not-found` 拒绝。评分与备注一旦记录就与该消息绑定并跨重启保留；会话的 fork 从没有反馈开始。

### 持久性

只有当评分所指的消息已被持久存储后，评分才会提交，因此反馈绝不会指向可能丢失的消息。读取或写入反馈绝不会启动或恢复 agent；服务直接检查已持久化的会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

服务把反馈完全放在会话日志之外：每个会话在存储域中拥有一条伴随记录行，因此评分绝不会与对话内容、模型历史或遥测混淆。伴随记录只在所引用消息已持久之后提交——该行是目标日志的延伸，而不是先于它。每个操作都返回业务结果，把已处理的失败（会话缺失、目标无效、版本陈旧、备注不合格）与基础设施故障区分开，后者会 reject 而非被误标。

### 伴随记录里有什么

每个会话一行，把检查所得的会话身份（`createdAt`、`cwd`）与其反馈条目绑定；该身份隔离复用的会话 id，因此更早生命周期的行不可见，fork 也从无反馈开始。条目是不可变值——修改会写入条目新版本并保留其创建时间——行 schema 拒绝重复消息 id 与复用的版本，保证查找无歧义。精确的行 schema 与校验见 [`src/spec.ts`](src/spec.ts)。

### 并发

修改是乐观的、按消息进行的：调用方发送其最后观察到的 version，陈旧的 version 会连同权威当前条目一起被拒绝，调用方无需再次读取即可协调；每次实质修改都会铸造新的 version token，陈旧写入绝不会被误认为当前。按 Session 的队列把整个读-比较-写串行化在一个服务实例内；存储不提供跨进程条件写，这正是下文「已知限制」。

### 持久性与目标校验

写入按「暂存—校验—提交」进行：目标消息先通过权威 checkpoint flush，再物理重读日志前缀，之后才写入伴随记录行——反馈绝不会引用尚未持久的消息。冷会话在不恢复 agent 的情况下被读取，缺失由持久化存储的 `stat` 判定而非猜测，只有真实发送过的 assistant 消息才是有效目标。flush 与读取路径见 [`src/index.ts`](src/index.ts)。

### 故障模式

服务失败时保持封闭：disposal 先排空在途写入再关闭域，disposal 开始后提交的写入会以生命周期故障拒绝，无效配置或域初始化前的读取都会明确失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务类：配置校验、按 Session 队列、持久性屏障、`@Remote` 方法 |
| [`src/types.ts`](src/types.ts) | 公开的请求、值与失败词汇（仅类型，供生成的 Remote 客户端使用） |
| [`src/spec.ts`](src/spec.ts) | storage-domain 声明：`message_feedback` 域、`sessions` 表、行 schema |
| — | 不发布运行时不变式伴生入口；域 schema 在重开时校验行。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从子系统类型与设计边界，逐步进入持久化原语与驱动此服务的浏览器消费方。

- [反馈子系统](../../../docs/subsystems/feedback.zh.md)——公开类型、Remote 契约与 Web 消费方细节。
- [消息反馈伴随记录决策](../../../.agents/notes/implemented/architecture/2026-08-10-message-feedback-sidecar.zh.md)——让此伴随记录不进入会话日志内容的设计边界。
- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——持久性屏障背后的 handle `read`、`stat` 与 `flush` 语义。
- [dsh-client-ui-message-feedback](../../client/ui-message-feedback/README.zh.md)——驱动 Host Remote 契约的浏览器消费方。
- [反馈包映射](../README.zh.md)——逐消息反馈与仅写入日志的采集命令并存的组。

-----

<a id="model-experience"></a>
## 模型体验

### 本地消息反馈状态

#### 模型看到什么

无。`ctx.messageFeedback` 不注册工具、提示词段落、模型可见上下文或 Session 事件；除非另一个具有独立文档的 Consumer 显式公开反馈，否则它只留在 Host 拥有的伴随记录中。

#### Token 影响

为零。本包的请求、结果、评分、备注、时间戳或失败都不会进入模型请求。

#### KV Cache 影响

相互独立。读取或变更消息反馈不会触碰模型请求前缀，也不会使本可复用的提供方缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明服务何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **Compare-and-set 仅限单进程**——按 Session 划分的队列只串行化一个服务实例；storage-domain 不提供跨进程条件写，因此多个 Host 进程写入同一存储根目录时仍可能丢失更新。
- **没有持久 Session 删除级联**——Session persistence 没有删除接口，且 `session/disposed`/`api-session/removed` 表示 detach 而非持久删除。因此服务会保留空行，并可能在带外移除日志后留下遗留行，而不会在 detach 时删除仍有效的反馈。
- **Header 身份不是内容指纹**——只有 `{createdAt, cwd}` 不同时才能识别复用；本契约无法区分保留相同 header 身份的克隆日志。
- **调用方边界受信任**——`list`/`put`/`delete` 不携带已认证的 actor 或审计身份。在加入授权与归属信息前，部署方必须只通过受信任或另行认证的边界暴露 Host gateway。
- **行边界**——`maxNoteBytes` 只限制单条备注，单个 Session 行的条目数和聚合保留字节尚无上限；由部署决定的行边界，延后到具体消费方明确策略时处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。已交付的行为、限制与理由以上文、包代码与所链接的 Agent Note 为准。

- 浏览器控件与客户端 Remote 挂载位于 `dsh-client-ui-message-feedback` 与 `dsh-api-remotes`；它们的开放事项属于这些包的备注。
- 受信任调用方限制是开放的授权方向：Host gateway 不记录任何 actor 或审计身份，任何认证层都必须在部署边界落地，之后服务才能暴露按用户归属。
- 按设计，备注校验早于 Session 查找，因此对不存在的 Session，`note-blank` 与 `note-too-large` 优先于 `session-not-found`；测试固定了这一顺序。

</details>
