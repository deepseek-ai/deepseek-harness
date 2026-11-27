---
description: "在 SQLite 中以每个事件一行的方式保存并重新打开 Session 历史，可用 SQL 查询，导入现有 JSONL 历史，并协调并发的读者与写者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

## 概述

在 SQLite 中保存 Session 历史，并通过原有持久化 API 重新打开。每个事件存为一行，序号、类型和时间各占一列，因此数据库还能用 SQL 回答有关事件、token 用量、工具调用和上下文压缩的问题。现有 JSONL 历史在首次打开时导入，源文件保持不变。读者可以与活跃写者共享数据库；每个 Session 只允许一个写者。需要显式选择此提供者：内置 profile 继续使用 JSONL。

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

在 profile patch 或 `--patch` 覆盖配置中禁用默认的 JSONL 提供者，并插入使用同一存储根目录的 SQLite 提供者：

```yaml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-sqlite
      name: '@deepseek-ai/dsh-session-persistence-sqlite'
      config:
        root: !!js dshHomePath('sessions')
```

fork 创建先排空本进程中的父写者，再在一个事务内引用已持久化的父前缀，并把 `endSeq` 之后的事件写入新的 Segment。读取打开与 fork 创建会等待本进程中正在关闭的父会话排空；排空或 flush 失败会停止创建。父会话后续写入仍属于父历史。前缀超过父会话已持久化事件数量时会拒绝创建；事务失败会回滚子会话并释放其写租约。若提交后路由发布失败，错误会说明历史仍已存储，可以重新打开 Session。

数据库位于 `<root>/.segments/sessions.sqlite`。应用调用方继续使用 `ctx.sessionPersistence` 及其 Session 句柄。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 包含数据库和现有 JSONL 历史的存储根目录。 |
| `compression` | `zstd` | 现有 JSONL 历史和新事件行的编码：`zstd` 在事件的 `data` 较大且压缩后更小时压缩它，`none` 存储 JSON 文本。已存的行按各自的 codec 解码。 |
| `listConcurrency` | `3` | 旧历史元数据及路由记录的并发文件系统读取数。 |
| `recovery` | `replace` | 数据库已损坏时的打开行为。`replace` 把损坏的文件移到一旁并开始一个空数据库，Session 仍然可用，字节仍可读回；`report` 拒绝打开，把存储根留给人工修复。锁定永远不算损坏，始终直接报告。 |
| `coldAfterDays` | `30` | 将闲置满指定天数的 Session 归档，设为 `0` 则禁用归档。禁用会停止新增归档，但仍可打开现有归档。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-sqlite)记录了所有可用字段。

### 查询数据库

DSH 运行期间，可以用任何 SQLite 3.38 及以上的客户端以只读方式打开 `<root>/.segments/sessions.sqlite`。请查询 `session_*` 视图：fork 出的 Session 与父 Session 共享此前的事件，这些视图会解析这种共享，返回每个 Session 的完整历史。

| 视图 | 每行对应 | `session_id` 之外的列 |
|---|---|---|
| `session_summary` | Session | `created_at`、`cwd`、`parent_session`、`origin`、`agent_preset`、`inherited_count`、`event_count`、`last_event_time` |
| `session_events` | 事件 | `seq`、`type`、`time`、`surface_op`、`source_seqs`、`ignorable`、`codec`、`data`、`event_no` |
| `session_llm_calls` | 报告了用量的模型调用 | `seq`、`time`、`provider`、`model`、`turn`、`step`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`reasoning_tokens` |
| `session_tools` | 工具调用，连同已存储的结果 | `seq`、`time`、`tool`、`turn`、`step`、`result_seq`、`is_error`、`error_code`、`duration_ms` |
| `session_tool_calls` | 工具调用 | `seq`、`time`、`tool`、`turn`、`step` |
| `session_tool_results` | 工具结果 | `seq`、`time`、`call_seq`（替换先前结果的结果为 NULL）、`is_error`、`error_code` |
| `session_compactions` | 一次 prune 或 summary | `seq`、`time`、`kind`、`shadowed_tokens`、`shadowed_start`、`shadowed_end` |

除 `session_summary` 和 `session_tools` 外，每个视图还返回 `segment_id`，即保存该行的 Segment。

```sql
SELECT tool, count(*) AS calls, sum(is_error) AS errors FROM session_tools WHERE session_id = ? GROUP BY tool;
SELECT sum(input_tokens), sum(output_tokens) FROM session_llm_calls WHERE session_id = ?;
SELECT seq, data ->> 'model' FROM session_events WHERE session_id = ? AND type = 'model/selection' AND codec = 0;
```

时间为 Unix 毫秒。`codec` 为 `0` 时 `data` 是 JSON 文本，SQLite 的 JSON 运算符可以直接读取；`codec` 为 `1` 时是 Zstandard 字节。由损坏的帧布局升级而来的数据库还会有 `codec` 为 `255` 的行：`type` 是 `storage/unreadable`，`data` 是空 blob，每个无法解码的序号一行。这些行保持 Segment 的事件计数，出现在 `session_events` 中，也计入 `session_summary.event_count`；读取含这类行的 Session 会以存储损坏失败。存值达到 1,024 个字符且压缩后更小时会被压缩，所以最大的事件正是 JSON 运算符读不了的：从已筛选的查询里 `SELECT` 一个 `data ->> ...` 表达式，因为结果中只要有一行被压缩，整条语句就会以 `malformed JSON` 失败。加 `AND codec = 0` 跳过这些行，或改用派生表。`llm_calls`、`tool_calls`、`tool_results` 和 `compactions` 表中每个已存事件只出现一次，统计整个存储的总量时请使用这些表；对 `session_*` 视图跨所有 Session 求和，会把共享事件按继承它的 Session 各计一次。token 列是每次调用报告的用量；DSH 显示的数字仍以 `tokenUsage` projection 为准。

新建或升级后的数据库在首次打开时会被分析一次，此后每次关闭都会刷新已变更表的统计信息。缺少这些信息时，SQLite 会为每个工具调用读取整个 Segment 的全部结果，而不是查找派生索引：在含 84,000 次工具调用的存储上，`session_tools` 在分析前需要 2.3 秒，分析后为 22 毫秒。

### 打开现有历史

首次 read 或 write open 通过版本迁移链解码选定的 JSONL 代次，然后将当前逻辑历史导入 SQLite。导入保留元数据、事件顺序、来源坐标和继承标记。它创建独立根 Segment，并保留 JSONL 源文件字节。导入后的 Session 及其后续事件通过 SQLite 重新打开。

活跃的 JSONL 写者保持所有权，直到关闭。SQLite read open 等待该所有权释放；竞争的 write open 会被拒绝。取消或提供者卸载会停止等待。导入后，读者可以在 SQLite 写者仍活跃时打开。`stat()` 和 `list()` 只观察元数据，不导入历史。

<a id="archiving-idle-sessions"></a>
### 归档闲置 Session

`coldAfterDays` 为正整数时（默认 `30` 天），数据库打开后会启动后台归档，此后每小时检查一次。闲置时间从 Session 创建时间、最后一个事件的时间和上次记录的打开时间中的最新值算起。启用归档时，提供者记录创建与打开时间，每个 Session 每小时最多刷新一次打开水位。共享 SQLite fork 历史的 Session、含升级搁置不可读事件的 Session、没有事件的 Session，以及 JSONL 大于 256 MiB 的日志仍保存在 SQLite 中。

提供者在 `<root>/.segments/sessions.sqlite.cold/` 中为每个归档的 Session 写入一个 Zstandard 12 级压缩的 JSONL 帧。这些内部文件不会替换已导入的 JSONL 代次，`recovery: replace` 在移动损坏数据库时会把归档目录一并移到一旁。数据库保留 Session 元数据、事件信封（`codec` 为 254，`data` 为空 blob）及已有派生行。以读或写方式打开时，提供者先将事件内容恢复至 SQLite 再返回句柄；从已归档 Session fork 非空前缀时也会恢复并把父 Segment 固定为内联存储；`stat()`、`list()` 以及针对信封或派生表的 SQL 查询不执行恢复。另一个进程中已打开的读句柄可直接读取归档，不触发恢复。归档缺失或损坏时拒绝打开，不退回到旧 JSONL 历史。

备份时，请停止所有写入进程，同时备份 SQLite 数据库和归档目录。归档释放的 SQLite 页可以复用，但数据库文件不会缩小。如需向文件系统返还空间，请[显式整理数据库](#compact-the-store)。

<a id="compact-the-store"></a>
### 整理数据库

归档会在 `sessions.sqlite` 内释放空闲页供后续写入直接复用，但数据库文件本身不会缩小。如需把未用页归还给文件系统，请停止所有使用该存储根目录的 DSH 进程，并在磁盘有余量重写数据库时运行 `sqlite3 <root>/.segments/sessions.sqlite 'VACUUM;'`；该操作不会改动冷归档。

提供者内部同时实现了基于独立线程的 `compactStorage()` 方法（执行 `VACUUM` 与 `PRAGMA wal_checkpoint(TRUNCATE)`，期间本地写入排队等待），不暴露在 `ctx.sessionPersistence` 上；取舍原因见[冷存储决策记录](../../../.agents/notes/implemented/architecture/2026-11-26-sqlite-cold-sessions.zh.md)。

### 持久化与关闭

直接 append、实时 Session 事件和持久化检查点使用同一个句柄。`flush()` 排空待写事件；写句柄关闭及提供者卸载会完成已接收的写入，再释放所有权。自动写入失败会保留待写批次并暂停自动写入；下一个显式检查点重试，并报告仍然存在的失败。

并发写者的编码批次一起进入队列时共用一个事务。每个批次有独立的保存点：批次自身的失败只拒绝该批次，其余批次照常提交；结束整个事务的错误则拒绝整组。路由发布在提交后进行，各批次独立完成或拒绝。提交或回滚结果未知时，提供者在重启前不可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件提供原有持久化服务，并在隔离的服务上下文中使用 JSONL 提供者读取旧历史。导入取得 Session 的文件租约，在数据库事务中提交元数据和事件，然后记录 SQLite 路由。write open 在交接过程中保持租约。

SQLite 保存 Session 元数据、前驱关联的 Segment 元数据和事件。`sessions` 以 JSON 保存每个 header，其字段作为生成列；header 损坏时这些列为 NULL。`segments` 记录每个 Segment 的父 Segment 和 `base_seq`，即其第一个事件的 Session 序号，也就是它在父 Segment 中的切点。`segment_paths` 为每个 Segment 列出它自身和每个祖先，以及一个不含端点的序号上界，该成员中序号小于它的事件属于此 Segment 的历史；插入 Segment 时由触发器填充，因此读取和视图都不需要递归。`events` 每个事件一行，以 `(segment_id, seq)` 为键，其中 `seq` 是 Session 序号。Segment 的事件数等于其最后一行的序号加一。读取按该键选出每个 Segment 的范围，在 JavaScript 线程上解码各行，每处理一组事件让出一次；缺失的行、未知的 codec、无法解码的字节或无效的事件都会以存储损坏拒绝读取。触发器拒绝删除事件和改动 Segment 的祖先关系，仅允许在内联存储和冷存储之间移动事件内容。视图 `segment_extents`、`session_heads` 和 `session_segments` 属于提供者内部：前两个供它的语句读取每个 Segment 的事件数，以及每个 Session 的 `head_segment_id` 所指的 Segment；每个 `session_*` 视图出于同样的原因连接 `session_segments`。

派生表由事件填充，提供者自身从不读取。每个 `Derivation` 声明一张以 `(segment_id, seq)` 为键的表、它读取的事件类型，以及一个把事件映射为一行的纯函数；存储会添加 `session_<name>` 视图。`derivations` 记录每张表的版本，以及表落后时已处理到的 `event_no`。表缺失、表的已存版本与其 derivation 不同，或表被加入已有事件的存储（例如升级后的存储）时，会在打开后以有界事务删除并从事件重新填充。已存的表若在当前构建中没有对应的 derivation，会被保留并标记为从该处起落后，待其 derivation 恢复后补齐。derivation 抛出异常，或其表拒绝某一行时，会跳过该行，绝不会导致追加失败；每张表首次出现这类失败时记录一条指明该事件的警告。导致事务终止的失败则会使该次追加连同其事件一起失败。

打开数据库时会依次执行 [migrations/](src/migrations/index.ts) 中的升级步骤：每一步在打开数据库的事务内把已存 schema 升级一个版本，因此某一步失败时文件保持不变。从版本 1 出发的一步把早先的帧布局改写为事件行，并保留 Segment 标识、祖先关系和继承计数；它按信封复制每个事件，因此当前构建不认识的事件类型也会被升级，待其 Session 被读取时再作判断。含有无法读取事件的帧会被记入日志并原样复制到 `frames_set_aside`；每个这样的事件由一行任何读取方都不解码的记录代替，帧的字节无法拆成事件时则由一行代替整帧，所以升级后读取失败的位置与升级前完全相同，其余 Session 照常升级。每一步改写数据库期间进程被阻塞，所以提供者会在该步开始前记录日志。某一步失败时，打开操作以 `SESSION_STORAGE_UPGRADE` 被拒绝，提供者在重启前不再重试。外来的数据库、比当前构建更新的版本，或缺少当前表的数据库会以 `SESSION_STORAGE_FORMAT` 被拒绝。

发布 schema 前先启用 WAL，防止并发读者阻碍首次模式切换。日志模式的锁竞争会在五秒 busy 等待预算内重试，此时尚未写入 schema 或 Session；持续的锁竞争及其他失败仍会报告。后端负责写入队列、实时事件缓冲、事务完成和句柄清理；调用方不直接访问 Segment。

| 源码 | 职责 |
|---|---|
| [persistence.ts](src/persistence.ts) | 服务路由和 JSONL 的持久接管。 |
| [migration.ts](src/migration.ts) | 导入排序、所有权交接和取消。 |
| [sqlite.ts](src/sqlite.ts) | 数据库、Segment 访问、句柄和持久化。 |
| [schema.ts](src/schema.ts) | 当前的 schema 版本、应用 id，以及每个当前数据库都有的表。 |
| [resources/sql/](resources/sql/schema/v3.sql) | 静态 SQL，包括按版本存放的 schema 脚本，以及事件、派生表和归档查询。已发布的 schema 脚本和升级语句不可修改。 |
| [sql.ts](src/sql.ts) | `resources/sql/` 的唯一读取方：封闭的文件名列表及其文本。 |
| [migrations/](src/migrations/index.ts) | 打开数据库：创建、依次执行的升级步骤和拒绝；每种已停用的布局一个模块，它只读取自己的 `upgrade/` 文件和它所写版本的 schema 文件。 |
| [row.ts](src/row.ts) | 事件行编码：信封列，以及以 JSON 文本或单个 Zstandard 帧存储的 `data`。 |
| [cold.ts](src/cold.ts) | 整段 Session 的 Zstandard 12 级 JSONL 归档写入与校验读取。 |
| [vacuum.ts](src/vacuum.ts)、[worker.ts](src/worker.ts) | 在独立线程连接上执行显式 `VACUUM` 与 WAL 截断。 |
| [derive.ts](src/derive.ts) | 派生表：`Derivation` 接口、随事件写入，以及从事件重建。 |
| [derivations.ts](src/derivations.ts) | 内置的 derivation 及其读取的事件成员。 |

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
- 其他 SQL 客户端没有 Zstandard 函数时无法读取以 `codec` 1 存储的 `data`；其余各列、派生表和小事件仍可读取。
- 派生表即内置的四张：没有设置可以关闭它们，也没有服务可供其他插件注册 `Derivation`。
- 不同构建的进程不得同时写入同一个数据库。较新的构建升级 schema 之后，较早的构建会失败。持有某个 derivation 的构建打开数据库时会补齐对应的派生表；如果此时缺少该 derivation 的构建仍有进程在运行并在此后继续追加，这些事件的派生行会一直缺失，直到该表的版本变化。
- 打开时如果遇到其他进程持有的写锁（例如正在进行的升级），所在进程会被阻塞五秒的 busy 超时，随后在所有平台上都以 `SESSION_STORAGE_LOCKED` 失败。SQLite 在进程退出时释放锁，所以超出超时的锁属于仍在运行的写者；替换它的文件会让该写者继续写入没有任何 Session 读取的字节。请关闭另一个进程后重新打开。
- 恢复是把损坏的数据库移到一旁而不是删除，所以每次恢复都会在存储根留下一份完整副本。不再需要其 Session 后，请删除 `*.unreadable-*` 文件。
- Session 无法删除，因此 fork 之间共享的存储永远不会回收。
- 恢复归档 Session 会在一个事务中提交全部内容，不会出现部分恢复。
- 全文 Session 搜索需要配置持久化索引 `path`；使用 `:memory:` 时启动会重建索引并重新打开每个已建索引的冷 Session。
- 新建或重建的派生表在 Session 重新打开之前无法从归档内容生成行。
- 进程中断留下的无引用归档不会自动清理。
- 在线空间整理（`compactStorage()`）属于本提供者内部方法，不在 `SessionPersistence` 公共服务接口上，因为其他持久化后端不需要 `VACUUM` 式空间回收，且没有外部触发入口调用它。
- `data` 较大的事件会让其最后一页留有未用空间：4 KiB 页时为存储的 12.8%，16 KiB 页降到 12.2%。
- 因为逐个压缩事件，存储比帧布局大。在 24.3 万事件的语料上实测为 294.3 MB，帧布局为 186.7 MB；把同样的事件按 64 个一组重新压缩得到 183.8 MB。共享压缩上下文因此能补回全部差额，但一次单事件读取需要解码整个分组：对活跃 Session 的点读慢 19 倍。行布局保留了这些读取的速度，具体数字见[决策记录](../../../.agents/notes/implemented/architecture/2026-11-25-sqlite-event-rows-and-derived-tables.zh.md)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
