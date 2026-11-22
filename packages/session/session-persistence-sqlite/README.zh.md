---
description: "在 SQLite 中保存和重新打开 Session 历史，导入现有 JSONL 历史，并协调并发读写。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

## 概述

在 SQLite 中保存 Session 历史，并通过原有持久化 API 重新打开。现有 JSONL 历史在首次打开时导入，源文件保持不变。读者可以与活跃写者共享数据库；每个 Session 只允许一个写者。需要显式选择此提供者：内置 profile 继续使用 JSONL。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

为需要使用 SQLite 的 Session 存储根目录挂载此提供者。

### 最小配置

在组合配置中替换 JSONL 提供者的包名，保留其根目录和旧历史编码设置：

```yaml
- name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    root: './.sessions'
```

fork 创建先排空本进程中的父写者，再在一个事务内引用已持久化的父前缀，并把 `endSeq` 之后的事件写入新的 Segment。读取打开与 fork 创建会等待本进程中正在关闭的父会话排空；排空或 flush 失败会停止创建。父会话后续写入仍属于父历史。前缀超过父会话已持久化事件数量时会拒绝创建；事务失败会回滚子会话并释放其写租约。若提交后路由发布失败，错误会说明历史仍已存储，可以重新打开 Session。

数据库位于 `<root>/.segments/sessions.sqlite`。应用调用方继续使用 `ctx.sessionPersistence` 及其 Session 句柄。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 包含数据库和现有 JSONL 历史的存储根目录。 |
| `compression` | `zstd` | 现有 JSONL 历史和新 SQLite 帧的编码：`zstd` 在压缩后更小时以压缩形式存储帧，`none` 存储 JSON 文本。已存帧按各自的 codec 解码。 |
| `listConcurrency` | `3` | 旧历史元数据及路由记录的并发文件系统读取数。 |
| `frameEvents` | `64` | 每个存储帧的最大事件数，即压缩和解码的单位。更大的帧压缩率略高，尾部读取的解码代价更大；已存帧保持写入时的大小。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-sqlite)记录了所有可用字段。

### 打开现有历史

首次 read 或 write open 通过版本迁移链解码选定的 JSONL 代次，然后将当前逻辑历史导入 SQLite。导入保留元数据、事件顺序、来源坐标和继承标记。它创建独立根 Segment，并保留 JSONL 源文件字节。导入后的 Session 及其后续事件通过 SQLite 重新打开。

活跃的 JSONL 写者保持所有权，直到关闭。SQLite read open 等待该所有权释放；竞争的 write open 会被拒绝。取消或提供者卸载会停止等待。导入后，读者可以在 SQLite 写者仍活跃时打开。`stat()` 和 `list()` 只观察元数据，不导入历史。

### 持久化与关闭

直接 append、实时 Session 事件和持久化检查点使用同一个句柄。`flush()` 排空待写事件；写句柄关闭及提供者卸载会完成已接收的写入，再释放所有权。自动写入失败会保留待写批次并暂停自动写入；下一个显式检查点重试，并报告仍然存在的失败。

并发写者的编码批次一起进入队列时共用一个事务。每个批次有独立的保存点：批次自身的失败只拒绝该批次，其余批次照常提交；结束整个事务的错误则拒绝整组。路由发布在提交后进行，各批次独立完成或拒绝。提交或回滚结果未知时，提供者在重启前不可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件提供原有持久化服务，并在隔离的服务上下文中使用 JSONL 提供者读取旧历史。导入取得 Session 的文件租约，在数据库事务中提交元数据和事件，然后记录 SQLite 路由。write open 在交接过程中保持租约。

SQLite 保存 thread 元数据、前驱关联的 Segment 元数据和帧：每次持久写入把其批次（每帧最多 `frameEvents` 条事件）以 JSON 行存入一行，以 Segment 和起始序号为键，`compression: zstd` 下在压缩后更小时以 Zstandard 压缩。Segment 的事件数取其最后一帧的结束序号。读取选出与请求范围重叠的帧，在线程池上每次并发解压八帧，只取覆盖的切片；帧缺失、帧短于记录范围、codec 未知或字节无法解码均以存储损坏拒绝读取。发布 schema 前先启用 WAL，防止并发读者阻碍首次模式切换。日志模式的锁竞争会在五秒 busy 等待预算内重试，此时尚未写入 schema 或 Session；持续的锁竞争及其他失败仍会报告。后端负责写入队列、实时事件缓冲、事务完成和句柄清理；调用方不直接访问 Segment。

| 源码 | 职责 |
|---|---|
| [persistence.ts](src/persistence.ts) | 服务路由和 JSONL 的持久接管。 |
| [migration.ts](src/migration.ts) | 导入排序、所有权交接和取消。 |
| [sqlite.ts](src/sqlite.ts) | 数据库、Segment 访问、句柄和持久化。 |
| [frame.ts](src/frame.ts) | 帧编码：JSON 行以文本或单个 Zstandard 帧存储。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 持久化](../session-persistence/README.zh.md) — 公共服务和句柄语义。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md) — 物理代次和版本迁移。
- [持久化子系统](../../../docs/subsystems/persistence.zh.md) — 恢复及面向调用方的 API。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的历史

#### 模型实际看到什么

此提供者不增加提示词或工具 schema。恢复的 `user/message` 和 `assistant/message` 事件提供相同的对话历史；Session 调用方负责 interrupted-turn 修复。

#### Token 影响

存储不增加 token。恢复历史仍有正常的对话成本。

#### KV Cache 影响

存储保留事件顺序，不改写模型请求前缀。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

选择此提供者时适用以下约束。

- 首次读取旧历史会写入 SQLite 数据库，因此需要存储根目录的写权限。
- 保留的 JSONL 文件只包含导入前缀，不包含后续 SQLite 事件；单靠它们无法恢复最新历史。
- 所有写入已导入 Session 的进程都必须使用 SQLite 提供者。
- SQLite 接受当前 Session 格式；未来事件格式升级需要独立的 SQLite 历史迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
