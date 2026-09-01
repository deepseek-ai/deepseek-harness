---
description: "面向部署方与维护者的 SQLite FTS5 会话历史全文搜索后端，用于选择、配置或排查查询服务之上的全文搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query-sqlite

[English](README.md) | 中文

## 概述

`dsh-session-query-sqlite` 用 SQLite FTS5 索引搜索会话历史，返回按会话分组或会话内排序、游标分页的结果。与 `dsh-session-query` 一起挂载，即可同时获得全文搜索与完整查询表面——精确读取、过滤与追踪。实时会话从内存索引，持久化会话从专用派生索引数据库索引，因此结果始终反映最新状态，且不触碰会话持久化存储。搜索是可选能力，已发布组合默认关闭：`openAt` 决定索引在启动时、首次搜索时打开，还是永不打开。设置与用法在前；实现内部细节放在下方可折叠的开发者章节中。

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

当组合需要对会话历史进行排序后的全文搜索时——例如 Web 内容搜索或 `/resume` 既往工作检索——挂载本包。常用路径是显式的：挂载插件、给它一个专用数据库路径，然后从代码调用 `ctx.sessionQuery.searchSessions` 或 `searchEvents`。

### 何时选择

当你想对既往会话进行带排序与分页的全文召回时选择它。它与 `dsh-session-query` 和会话服务一起使用；持久化后端可选但建议挂载，这样重启后持久化历史仍可搜索。不要把 `path` 指向 session-persistence 数据库——本包拥有独立的派生索引。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/session-search.db
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | 专用派生索引 SQLite 路径，或 `:memory:`；POSIX 上缺失的路径会以仅所有者可访问的方式创建 |
| `openAt` | `startup` | `startup` 在激活时打开；`first-search` 把 SQLite 模块推迟到首次搜索；`never` 关闭全文搜索，继承的读取保持可用 |
| `journalMode` | `wal` | `wal`、`delete`、`truncate` 或 `persist` |
| `defaultLimit` | `20` | 请求省略 `limit` 时的分页大小 |
| `maxLimit` | `100` | 接受的最大请求分页大小 |
| `snippetChars` | `240` | 按 Unicode 码点计算的最大 snippet 长度 |
| `readWindowMax` | `50` | 继承的 `readEvent()` 的 `before`/`after` 原始事件数上限 |
| `persistedInspectConcurrency` | `4` | 继承批量读取的并发持久化日志检查数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-query-sqlite)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索行为

`searchSessions` 搜索整个语料库，并按每个会话匹配最强的事件分组结果；`searchEvents` 搜索一个逻辑会话。查询是字面短语：首尾空白会被移除、内部空白会被规范化，引号、`OR`、`NEAR` 和 `*` 等 FTS5 语法被视为数据，绝不作为可执行查询语法。元数据过滤器（会话 id、cwd、创建时间、父级、可用性、事件 seq/时间/类型/表层）在排序前缩小结果。默认搜索全部 `current`、`shadowed` 与 `log-only` 事件；传入表层过滤器可缩小范围。

排序是确定性的：实际 FTS5 高亮匹配 span 更多的在前，然后文档更短的在前，事件时间、会话 id 与 seq 打破平局。结果携带按 `snippetChars` 个 Unicode 码点截断的纯文本摘录，没有提供方专用数值分数。分页通过不透明 `SessionSearchCursor` 延续，游标绑定到规范化后的确切请求；相关语料库变化时游标变为陈旧（`SESSION_QUERY_STALE_CURSOR`），会话内游标可在不相关会话变化后延续，跨会话游标则不能。

`unicode61` tokenizer 匹配 token 与短语，而非任意子字符串：`AI` 不匹配 token `BRAID`。需要执行字面、空白灵活的字符串子串扫描时，使用带 `text` 子句的 `ctx.sessionQuery.filterEvents()`。

### 何时推迟或关闭搜索

使用 `openAt: first-search` 时，服务在不导入 `node:sqlite`、不打开索引的情况下激活，把 SQLite 的实验性警告推迟到首次实际搜索；无效数据库让首次搜索失败，而不是服务激活失败。使用 `openAt: never` 时，全文搜索对该部署关闭：`searchSessions` 与 `searchEvents` 在任何请求规范化之前就以 `SESSION_QUERY_SEARCH_DISABLED` 失败，而继承的全部精确读取、过滤与追踪保持可用。请求超过编译谓词预算（跨会话 14 个组合谓词、会话内 13 个）或 SQLite 可移植的 32,766 绑定上限时，会在准备语句前以 `SESSION_QUERY_INVALID_FILTER` 失败。

### 失败与恢复

带类型的 `SessionQueryError` 失败携带稳定代码：搜索配置为关闭时 `SESSION_QUERY_SEARCH_DISABLED`；索引无法打开或对账时 `SESSION_QUERY_INDEX_FAILED`；搜索目标不存在时 `SESSION_QUERY_SESSION_NOT_FOUND`；语料库在分页之间变化时 `SESSION_QUERY_STALE_CURSOR`——请重试完整的搜索调用；游标不属于该请求时 `SESSION_QUERY_INVALID_CURSOR`。取消在同步 SQLite 调用之间被尊重；已在 JavaScript 线程上执行的语句无法被中断。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本后端建立在一个分离与三项承诺之上：

- **派生索引，绝不动源存储。** FTS 行存放在专用可丢弃数据库中；这里的代码从不打开 session-persistence 数据库。
- **实时优先的观察。** 一个串行化状态机比较持久化快照修订，只检查新增或已更改日志，并在一个事务中对账，因此搜索反映最新的稳定状态。
- **世代绑定的游标。** 每次语料库变化都会递增世代；游标携带其创建时的世代，宁可陈旧失败也不返回偏移后的页面。
- **字面短语即数据。** 调用方查询文本被引成一个 FTS5 短语，查询语法保持惰性；保留高亮标记在索引前从文档中剥离。

设计历史记录在 [SQLite FTS5 会话搜索笔记](../../../.agents/notes/implemented/feature/2026-07-10-sqlite-session-query-provider.zh.md)与[统一服务决策](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md)中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：配置、openAt 生命周期、串行化对账、查询执行、游标 |
| [`src/query.ts`](src/query.ts) | 请求规范化、参数化谓词、摘录、谓词与绑定预算 |
| [`src/schema.ts`](src/schema.ts) | 数据库 schema、application id 归属、原地重置、仅所有者文件创建 |
| — | 不发布运行时不变式伴生入口；边界在每次串行化查询时校验。 |

### 索引生命周期

持久化 FTS 行存放在专用派生数据库中并跨重启保留；实时会话使用连接本地 TEMP 表，遮蔽同一会话的持久化基库，并在实时所有者脱离后再次显示基库。每次搜索执行一次串行化观察：列出持久化快照、把逐会话修订与已索引行比较、只检查新增或已更改日志、提取语义文档，并在运行查询前于一个事务中提交对账。重复查询与不变的重新打开不会检查任何内容；切换存储或观察到新增、已更改、已删除或经外部修复的来源时，会在下次稳定观察时对账。来源或事务失败不提交任何内容，下一次搜索重试。

### Schema 归属

数据库携带 application id 与 schema 版本 8。打开时拒绝其他应用程序拥有的文件或规范数据库，拒绝未知用户表；只有已识别的不兼容派生 schema 才会原地重置——因此不相关或 session-persistence 数据库绝不会被触碰。在 POSIX 文件系统上，缺失的目录与数据库文件以仅所有者可访问的方式创建（进程 umask 前为 `0700` 与 `0600`）。每个派生索引路径在一个进程中只能由一个服务拥有；世代与 TEMP 遮蔽状态由连接持有。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享查询服务逐步进入类型级约定与设计证据。

- [会话查询子系统参考](../../../docs/subsystems/session-query.zh.md)——本后端实现的完整类型级约定。
- [dsh-session-query](../session-query/README.zh.md)——服务定义：本后端继承的精确读取、过滤与追踪。
- [dsh-tool-session-query](../tool-session-query/README.zh.md)——调用这些搜索方法的面向模型消费方。
- [SQLite FTS5 会话搜索](../../../.agents/notes/implemented/feature/2026-07-10-sqlite-session-query-provider.zh.md)——搜索语义、对账与 tokenizer 决策。
- [JSONL 会话持久化](../../session/session-persistence-jsonl/README.zh.md)——本可丢弃索引观察的权威 Session store；其 root 必须与本包的数据库路径分开。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该搜索后端只向调用方返回命中，且不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 SQLite 对比或任务积压。

- **无调用方授权**——这是上下文范围内的可信服务；模型工具或 UI 必须强制执行自己的访问策略。
- **同步查询执行**——`DatabaseSync` 在 MATCH 执行期间会阻塞 JavaScript 线程，且无法中断已运行的语句。
- **Token 召回，而非任意子字符串**——`unicode61` tokenizer 不会匹配更大 token 中的子字符串；对字面扫描使用 `filterEvents()`。
- **单一所有者的派生索引**——每个索引路径必须仅归一个进程中的一个服务所有；不支持外部写入者与多进程共享。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：其他 tokenizer 与搜索提供方

`unicode61` tokenizer 的选择以索引体积与双字符 token 支持换取子字符串召回；trigram 备选方案曾被测量并否决。切换 tokenizer 或增加另一个搜索后端会改变索引召回，并需要各自的对账与世代方案。

</details>
