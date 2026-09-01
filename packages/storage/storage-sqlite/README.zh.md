---
description: "SQLite 存储后端：面向在单个数据库文件中选择、配置或排查按行存储文档的 KV 存储的宿主与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-sqlite

[English](README.md) | 中文

## 概述

`dsh-storage-sqlite` 是一个存储后端：把每个已路由单元托管在同一个 SQLite 数据库文件中，每条记录按行存储一份 JSON 文档，注册为后端 `sqlite`。单条记录更新恰好触碰一行，这正是它适合高频定点写入的原因。当领域数据变动频繁、或部署偏好单一可查询数据库时选择它；当数据需要以纯文本文件形式可读时选择 JSON 后端。本后端只面向宿主侧：它不贡献提示词、工具或 schema，因此模型与 agent loop（智能体循环）永远不会看到它。

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

当组合把频繁更新的领域数据保存在一个数据库中时使用本包：把相关领域路由到此后端，每个单元即作为表物化在配置的数据库文件中。

### 何时选择

当写入频繁且为定点更新时选择它——每个键恰好映射到一行，因此更新一条记录只触碰一行，而不是重写整个文件。当人类需要以纯文本文件查看或编辑已存数据时选择 JSON 后端。同步的 `node:sqlite` 驱动会在每条单语句调用期间阻塞 JavaScript 线程，这在领域数据规模下可以接受，但高写入率时值得纳入考量。

### 配置

两个字段：数据库路径与 journal mode。`:memory:` 打开一个进程内数据库，其内容随进程消失。

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-sqlite'
  config:
    path: /var/lib/dsh/data.db
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: sqlite
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | SQLite 数据库文件路径，或 `:memory:` |
| `journalMode` | `wal` | Journal mode：`wal`、`delete`、`truncate` 或 `persist` |

`wal` 适合本地磁盘；回滚日志模式（`delete`／`truncate`／`persist`）适合 WAL 共享内存文件不可用的文件系统，例如网络挂载。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-storage-sqlite)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可观察行为

缺失的目录与数据库文件会以仅所有者可访问的权限创建（`0o700`／`0o600`）；已有数据库保持其既有模式。已存格式版本与描述符不同的单元拒绝 `version-mismatch`，盖有非当前物理布局版本的数据库会直接拒绝——不做迁移，预发布立场。失败携带稳定的 `StorageError` 代码，写入 resolve 后即已持久。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本后端是在单个 `node:sqlite` 连接之上的文档按行布局，设计目标是让每次按键更新都是一条预处理语句。

### 设计理念

- **每行一份文档。** 每个单元表都变成一张物理 STRICT 表 `u_<unit>_<table> (key TEXT PRIMARY KEY, value TEXT)`，其 `value` 列保存记录的 JSON 文本；全局单例存放在共享的 `unit_globals` 表中。一个键的更新恰好触碰一行——这就是把高频变更领域路由到这里的原因。
- **单语句原子性。** 每个写入原语都是一条预处理语句，因此 SQLite 的逐语句原子性无需显式事务即可满足 KV 约定；写入顺序仍由调用方负责（领域层的写入链）。
- **名称在 DDL 之前校验。** 单元名与表名在进入 DDL 之前必须匹配 `UNIT_NAME_RE`，因此任何外部输入都不会被插值进 SQL 标识符。
- **版本明确报错。** 物理布局版本存放在 `PRAGMA user_version`（全新数据库最后盖戳）；单元格式版本存放在 `units` 表中。任何其他已标记值都会被拒绝——不做迁移。

### 打开顺序

打开数据库时会以 `0o700` 创建父目录、以 `0o600` 独占创建缺失文件、应用 `PRAGMA foreign_keys = ON` 与 journal mode、检查 `user_version`、创建 `units` 与 `unit_globals` 元数据表，并在最后给全新数据库盖戳，让失败留下未盖戳的介质。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：后端注册、`path`／`journalMode` 配置、单元表 |
| [`src/schema.ts`](src/schema.ts) | 打开顺序、物理布局版本、元数据表、记录表命名 |
| [`src/unit.ts`](src/unit.ts) | 一个已打开单元：预处理语句、JSON 值解析、关闭 |
| — | 不发布运行时不变式伴生入口；版本是打开时检查。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本后端视角不够用时阅读以下页面：子系统参考是权威约定，兄弟后端展示了另一种介质。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——后端约定、领域语义与生成的 API。
- [存储包映射](../README.zh.md)——家族的各包及其在仓库中的位置。
- [JSON 存储后端](../storage-json/README.zh.md)——面向小而可检查数据的人类可读介质。
- [领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——后端家族背后的设计与被推迟的会话后端迁移。

-----

<a id="model-experience"></a>
## 模型体验

### 已存领域记录

#### 模型看到什么

无。本后端不贡献提示词、工具或 schema；它在 `ctx.storage` 后面持久化非会话领域数据，只供宿主侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：本后端从不触碰实时请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **同步驱动阻塞事件循环**——每次写入都是一次同步 `DatabaseSync` 调用；阻塞只持续一条语句，在领域数据规模下可以接受。
- **没有忙等待或重试策略**——持有写锁的竞争连接会立即拒绝操作，而不是等待；领域层的写入链在单进程内串行化写入，跨进程协调属于范围外。
- **只打开当前的物理布局版本**——任何其他已标记的 `user_version` 都会被拒绝而不是迁移（预发布立场）。
- **打开顺序与 query provider 重复**——`openDatabase` 与 `session-query-sqlite` 都强制执行 SQLite 文件 ownership，但两个 package 分别拥有不同的 application identity 与 schema；没有共享 medium helper 将其耦合。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
