---
description: "通过 Session 持久化插件将历史保存到 SQLite，并导入保留的 JSONL 日志。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

## 概述

在保留现有 Session 读写接口的同时，将 Session 历史保存到 SQLite。Session 持久化插件通过此库保存新 Session，并在首次打开时导入支持的 JSONL 历史。导入源文件保留用于归档。Node 主机使用 SQLite；浏览器 Worker 选择插件的 JSONL 后端。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

通过 [Session 持久化插件](../session-persistence-jsonl/README.zh.md)配置存储。此库没有独立的 Cordis 插件入口。[公共导出](src/index.ts)向该插件提供存储实现；应用消费者使用 [Session 持久化服务](../session-persistence/README.zh.md)。

### 存储与导入

插件将数据库保存到 `<root>/.segments/sessions.sqlite`。新 Session 将元数据和事件历史提交到 SQLite。尚未追加事件的 Session 在所有者 flush 之前不会物化。SQLite 使用 WAL 模式和 FULL 同步提交；flush 等待已接收的写入，失败会使持久化检查点拒绝。

打开支持的 JSONL 历史时，获取 Session 的旧写租约，通过现有格式迁移链读取，并在一个事务内导入元数据和事件。原始代际保持不变。只读打开遇到其他导入者时，等待其提交，然后在写入者仍活跃时读取 SQLite。写打开仍拒绝所有权竞争。取消或 provider 卸载会停止读者等待。list 和 stat 不导入历史。

导入后，Session 从 SQLite 读取。数据库旁的路由记录保留此选择；路由记录仍在而数据库文件缺失时会报错。保留的 JSONL 文件不包含后续 SQLite 事件，也不提供自动回退或降级。

### 关闭与所有权

每个 Session 允许一个写入者。关闭开始后，公共句柄操作拒绝调用。关闭排空待写事件期间，仍接收已路由的实时事件；排空完成后释放写入者和路由。存储失败仍向所有者报告。provider 卸载在依赖消费者退出后移除监听器并关闭剩余句柄。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

`TracePersistence` 将 SQLite 历史与旧日志发现、导入结合。`SqliteLogs` 在独立根 Segment 中保存逻辑事件 JSON 和源事件序号数组。数据库 schema 检查与创建共享一个事务；schema 版本单调递增。Session 租约跨进程协调写入者，已提交路由记录为后续打开选择数据库。

| 文件 | 职责 |
|---|---|
| [persistence.ts](src/persistence.ts) | Session 服务实现与持久路由 |
| [migration.ts](src/migration.ts) | 旧日志导入所有权与等待的读者 |
| [sqlite.ts](src/sqlite.ts) | 数据库事务、读取、实时事件与句柄关闭 |
| [lease.ts](src/lease.ts) | 跨进程写入所有权 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 持久化子系统](../../../docs/subsystems/persistence.zh.md)说明共享服务语义。
- [Session 格式目录](../session-format-catalog/README.zh.md)定义支持的逻辑历史版本。
- [SQLite 存储升级](../../../docs/upgrade-guide/v0.2.2-rc.2/session-sqlite-storage/guide.zh.md)说明备份与存储选择。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到的内容

SQLite 存储不添加实时提示词或工具 schema。Session 加载器重建记录的历史；中断 turn 通过恢复行为记录 `TOOL_NOT_STARTED` 或 `TOOL_OUTCOME_UNKNOWN`，详见 [Session 持久化服务](../session-persistence/README.zh.md)说明的恢复行为。

#### Token 影响

不增加实时请求 token。恢复请求包含保留的历史及 Session 加载器提供的恢复结果。

#### KV Cache 影响

SQLite 存储不改变实时请求前缀。恢复时的缓存复用取决于重建历史与当前模型路由。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **需要 Node 运行时** — 后端使用 Node SQLite 和平台写锁；浏览器 Worker 通过持久化插件使用 JSONL。
- **导入不进行格式同步** — 导入后，保留的 JSONL 代际不再接收事件；切换存储无法从这些文件恢复后续 SQLite 写入。
- **备份完整存储根目录** — 路由记录与数据库历史必须一起保留；只复制保留的 JSONL 会丢失后续事件。复制根目录前停止写入者。
- **每个 Session 一个活跃写入者** — 读者可以与该写入者并存，但竞争的写打开会拒绝。
- **Session 历史持续积累** — 持久化服务没有删除 API。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
