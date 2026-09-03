---
description: "面向部署方与维护者的持久会话投影缓存说明，用于选择、配置或排查持久检查点、零 I/O 列表读取与加速的冷投影折叠。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-cache

[English](README.md) | 中文

## 概述

`dsh-session-projection-cache` 将每个已注册投影单元的状态检查点（`ctx.sessionProjectionCache`）存为 `session_projcache` 存储域 `per-record` 布局下的逐会话版本化文档。随附 JSON 后端将每条记录存于 `<root>/session_projcache/sessions/<id>.json`，缓存绝不读取会话持久化层。存储行是折叠捷径，绝不是权威：它可能陈旧——`seq` 精确说明陈旧到哪——但绝不会错。三个必写点（会话创建、`turn/end` 与会话释放）加上可配置的条数与间隔节流让缓存保持新鲜。当列表视图需要同步缓存值，或冷投影折叠应跳过已检查点化的前缀时，选择本包。

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

当客户端应在不加载日志的情况下列出冷会话投影值时，把本包与投影注册表及存储栈一起挂载。没有它时，消费方必须先取得日志，才能重建冷投影值。

### 何时选择

当部署会重启会话，并需要为历史列表、统计信息或 goal 快照提供持久投影值时，选择本包。当投影只服务实时会话，或额外存储写入的成本高于所节省的投影工作时，跳过本包。

### 最小配置

两个节流字段均必填——写入节奏是部署选择，没有普适正确值：

缓存通过存储栈打开自己的域，因此 base 先挂 `storage`、`storage-json`（根 `dshHomePath('storages')`）与 `storage-domain`（`backend: json`）：

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `writeEveryEvents` | 必填 | 在各必写点之间强制一次持久检查点写入的每会话已提交事件数 |
| `writeIntervalMs` | 必填 | 各必写点之间脏检查点最长可保持未写入的时间 |

本插件注入 `storageDomain`、`sessionProjections` 与 `sessions`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-projection-cache)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 检查点如何写入

三个必写点总是写入：会话创建保存由种子派生的切面，`turn/end` 保存列表读取所需的轮次终值，会话释放保存最终实时切面。其间，配置的条数与间隔节流随事件累积写入。每次写入通过领域写入链以原子方式替换该会话的完整记录；失败会记录警告并让缓存保持陈旧，后续写入会自行修复。

### 读取缓存值

`cachedSnapshot(meta, inheritedEventCount)` 以零 I/O 从存储域的内存表同步提供客户端值。它只接受身份匹配的记录以及版本和 schema 均匹配的 key，再按所服务行的最低水位返回 `{ asOfSeq, values }` 切面。未 seeded 的列表知道切点为零；仅 header 的 seeded 列表不知道数字切点，必须跳过该快速路径，直到权威正文读取提供它。`coldSnapshot(meta, inheritedEventCount, events)` 接受精确切点与完整有序日志，在折叠时跳过已检查点化的前缀，并在自身不读取持久化层的情况下刷新记录。

### 缓存保证什么

日志领先，缓存跟随：实时检查点先把会话的缓冲事件持久化，然后才保存缓存记录。因此崩溃可能让缓存落后于日志，但绝不会让缓存领先。读取和写入共享存储域内一致的内存状态；逐单元写入链只在持久化成功后修改内存。每个带版本戳的记录必须匹配实时单元 schema 与完整生命周期身份（`createdAt`、`cwd`、`isSeeded` 和 `inheritedEventCount`），因此在一个 fork 切点下初始化的行不能播种另一个切点。JSON 后端把每条记录存于仅所有者可访问的 `<root>/session_projcache/sessions/<id>.json` 目录树中。

升级绝不拖垮启动或列表：版本戳落在 spec `compatibleVersions` 集合内的记录保持可读（缺失的 lineage 字段解码为 unseeded lineage——对非 fork 会话精确无误，seeded 调用方则通不过身份比对、回落冷折叠），而仍然通不过 schema 校验的存量记录会按域的 `invalidRecords: 'backup-and-skip'` 策略移出为 `<id>.json.bak.<时间戳>`、连同原因写入日志，并由下一次检查点重建。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明缓存的持久性与存储所有权；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

缓存是投影注册表检查点接口上的折叠捷径，存于 `per-record` 领域数据表中。它带来六项后果：读取绝不绕过领域写入链；每次后台写入都 fail-soft；`ver` 不匹配时丢弃而不迁移记录；记录必须通过实时单元的 `stateSchema`；写入通过无损 JSON 边界替换一份完整会话记录；日志领先，缓存跟随。

### 读写所有权

缓存在 `session_projcache` 领域中为每个会话保存一份带版本戳的文档。它不依赖会话持久化后端，不调用 `locate`，也不检查逐会话目录。畸形或陈旧的记录读作不存在；需要冷值的消费方负责提供日志以重新折叠。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SessionProjectionCache` 服务、写后监听器、缓存读取 |
| [`src/spec.ts`](src/spec.ts) | `session_projcache` 域 spec 与记录身份类型 |
| — | 不发布运行时不变式伴生入口；正确性在写入与读取路径强制。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从缓存逐步进入它检查点化的注册表与保存其记录的存储域。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——本缓存检查点化的投影单元约定与驱动语义。
- [会话投影注册表](../session-projection/README.zh.md)——本缓存持久化其检查点的 `ctx.sessionProjections` 服务。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——保存缓存记录的领域路由与后端行为。
- [会话包映射](../README.zh.md)——相邻的持久化、标题与遥测包。
- [会话投影 RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)——持久投影缓存的设计理由。

-----

<a id="model-experience"></a>
## 模型体验

无，因为持久缓存只加速主机侧的投影状态读取，不注册任何模型可见内容。

#### KV Cache 影响

无；缓存从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明缓存何时需要运维注意。它们是当前包约束，不是任务积压。

- **无淘汰或保留接口**——记录按会话持续累积；清理已存储检查点属于带外维护，与会话持久化采用相同策略。
- **间隔节流采用按会话的粗粒度控制**——一次无脏数据的写入完成后，计时器在首个脏事件到达时启动；持续但低于条数阈值的事件流每间隔写入一次，而非滑动窗口。
- **缓存侧不做冷重折叠**——缓存只服务并刷新自己的记录，从不读取会话日志，因为它不依赖持久化层；需要保证冷快照的消费方自行从日志重新折叠。
- **每次 schema 或域版本变更都必须论证升级路径**——改动存储记录 schema 或域版本时，同一 PR 必须在 `tests/fixtures/` 下归档此前已发布的磁盘格式样本，并在 `tests/fixtures.spec.ts` 中用测试论证所选的处置方式：读兼容恢复（`compatibleVersions`）、当前版本重写，或 backup-and-skip 抢救。即便选择直接丢弃旧记录的 bump，也要证明丢弃既不炸启动、也不污染缓存树。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
