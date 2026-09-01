---
description: "面向部署方与维护者的随产品交付 JSONL 会话持久化后端说明，用于选择、配置或排查带可选 Zstandard 压缩的逐会话持久日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

[English](README.md) | 中文

## 概述

`dsh-session-persistence-jsonl` 把每个会话存为一份仅追加 JSONL 日志——默认以带校验和的 Zstandard 帧存储，禁用压缩时以换行分隔的原始文本行存储。它提供与任何持久化后端相同的逻辑 `SessionEvent` 流，因此选择它不会改变 agent loop、模型或回放的任何行为；压缩、打包与崩溃恢复都是存储内部细节。当消费方需要按会话的磁盘产物时选择它：`locate(meta)` 返回 transcript 路径，选择 `compression: 'none'` 后日志可作为纯文本按行读取。根目录是唯一必填配置；持久性、延迟实体化与中断轮次恢复都随后端提供。

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

当组合需要由按会话文件支撑的持久会话时挂载此后端。常用路径是显式的：加载会话服务、挂载后端，然后给出根目录。

### 何时选择

当消费方受益于每会话一份产物——导航、外部工具或可逐行读取的原始日志——时选择此后端。它是随产品交付的唯一 Session 持久化 provider。后端把会话保存在部署控制的根下：项目本地、共享、临时或集中式。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
```

`root` 必填且无默认值：`process.cwd()` 默认值会随进程 cwd 变更而分散会话文件。现有根必须是可读目录；缺失根在第一次实体化时创建。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 所有会话文件的根目录 |
| `packChunks` | `true` | 把符合条件的 `assistant/chunk` 连续段写为打包行；`false` 为诊断保留每事件一行 |
| `compression` | `'zstd'` | 物理编码：`'zstd'` 带校验和帧，或 `'none'` 换行分隔 UTF-8 文本 |
| `preparedSessionCacheSize` | `5` | 为恢复复用而保留的冷会话准备结果数量 |
| `writeBatchMaxDelayMs` | `200` | 实时事件的固定聚合窗口，单位为毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-jsonl)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 磁盘布局

每个会话在可读项目目录下获得一个会话自有目录；日志第一个逻辑行是不可变 `SessionHeader`，之后每个逻辑事件一条存储记录（或每个符合条件的连续段一条打包分片行）。存储记录使用下文所述的无损来源序列表示：

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # default: checksummed header frame + append frames
      session.jsonl              # only with compression: 'none'
```

会话 id 在使用前被单射转义为一个安全路径段（无遍历、无冲突）。规范化 cwd 让项目目录保持可读、便于导航；规范化相同的 cwd 字符串共享项目目录，而会话 id 仍选择不同会话目录。`locate(meta)` 返回已解析目录内固定 transcript 的 `{ kind: 'jsonl', path }`，不执行任何文件系统 I/O。

### 持久性与崩溃语义

会话延迟实体化：`create(meta)` 不写入任何内容，第一次 `append` 通过无覆盖发布写入并 `fsync` 编码后的 header 与第一批——因此已创建但从未 append 的会话不留下任何磁盘内容，除非生命周期消费方调用 `ensureMaterialized`，以无事件的单个 header 帧发布它。已 flush 事件绝不重写；后续每个批次追加行或一个压缩帧，捕获到写入或同步失败时把文件回滚到之前的字节长度。崩溃后，`load` 保留被中断的最终轮次：保留不完整最后帧中完整解码的记录，从该帧开头截断，并按共享持久化约定的要求，用合成工具、步骤与轮次 closer 重新编码这些记录。只有从未完整写入的撕裂尾部被丢弃；已提交前缀中的校验和、解压或结构失败以损坏拒绝。

### 读取日志

`inspect(id)` 返回不可变的平衡视图，不提交恢复。`readFrom(id, fromSeq)` 为水位消费方返回该序列号及之后的已存储事件；JSONL 这类顺序介质解析整个产物并向前跳过。选择 `compression: 'none'` 后，日志是外部读取方可直接消费的换行分隔文本；压缩默认值必须经后端读取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明物理编码与写入路径；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

该后端是共享 [PersistenceCoordinator](../session-persistence/README.zh.md#understand-the-implementation) 之上的一层薄存储：它加载已存储记录、追加批次、提交修复，并把生命周期编排委托给协调器。其物理身份是文件修订值：device、inode、size 与纳秒时间戳标识一份日志，并在追加或修复后改变，这正是 `listSnapshots` 与保留准备结果校验所使用的身份。

### 物理编码

默认产物是独立 [Zstandard 帧](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md) 的标准拼接：一个仅包含 header 行的带校验和帧，后跟每个持久 append 批次一个带校验和帧，使用 Node 内置 Zstandard API 的默认压缩级别（无级别开关）。`sourceEventSeqs` 使用无损存储形式：至少包含三个序列号的连续段会变成 `[start, end]` 区间对，其他列表原样保留；读取时会展开回精确的内存数组。列表只读取并验证 header 帧。`compression: 'none'` 保留相同的存储形式逻辑行，但不使用帧压缩。一个根只属于一种编码：启动发现与定向查找会拒绝相反后缀，且不提供格式或压缩迁移、混合根回退或双写。启用 `packChunks` 时，符合条件的 ≥3 个连续同 block `assistant/chunk` delta 事件连续段会变成一行打包行（`text-chunks`/`reasoning-chunks`/`tool-call-chunks`），其 `seq0`/`time0` 与各成员的 `dt` 间隔精确重建每个成员；无损 codec 位于 `dsh-session`，读取与布局无关，因此打包、非打包与混合文件加载结果一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、后端类、协调器接线 |
| [`src/format.ts`](src/format.ts) | 日志路径派生、header 编码、记录扫描、打包行布局 |
| [`src/zstd.ts`](src/zstd.ts) | Zstandard 帧压缩、解码与帧扫描 |
| [`src/win32.ts`](src/win32.ts) | Windows write-through 发布与目录创建 |
| — | 不发布运行时不变式伴生入口；身份在存储层强制。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享持久化模型逐步进入同级后端与物理格式决策。

- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——后端无关的服务语义与提供方关系。
- [会话持久化 seam](../session-persistence/README.zh.md)——本后端实现的服务约定。
- [项目会话目录决策](../../../.agents/notes/implemented/architecture/2026-07-24-project-session-directories.zh.md)——项目与会话目录布局背后的取舍。
- [Zstandard JSONL 会话日志](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md)——带校验和帧编码的理由。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

JSONL 存储不会向实时请求提供提示词或 schema。加载会恢复已存储的表层历史，并保留之前的请求 header 用于重建；新 loop 组合当前 envelope。恢复会用 `TOOL_NOT_STARTED` 平衡没有持久调用的 assistant 请求；持久调用无结果时则变为 `TOOL_OUTCOME_UNKNOWN`，它要求模型只重试只读或幂等工作，并验证可能的副作用或询问用户。原始 `assistant/chunk` 记录不会重复生成消息。

#### Token 影响

实时请求不新增 token。恢复后的 agent（智能体）会因保留的历史、当前 envelope，以及每个中断调用中以引用形式加入的修复结果文本而消耗 token。

#### KV Cache 影响

JSONL 存储不修改实时请求前缀。只有重建历史、当前 envelope 与模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **只加载已配置编码和当前 `SESSION_FORMAT_VERSION`（v0）**——更改压缩需要独立或全新根，或选择原始文本模式；预发布格式没有迁移。
- **平铺文件存储布局不加载**——加载前使用独立根，或将预发布产物移入项目/会话目录布局。
- **压缩文件不能直接按行读取**——使用后端加载；或在写入新根前选择 `compression: 'none'`，供外部行读取方使用。
- **不删除会话文件**——日志在 `root` 下累积，直到外部移除；seam 无删除接口。
- **每会话一个活动写入方**——append 与修复只在所属后端实例内协调；在该所有者达到完全停稳的 dispose 前，另一实例或进程不得写入同一会话。
- **POSIX 实体化需要硬链接支持**——第一次 append 使用 `link()`，使同 id 竞态失败而不覆盖已提交日志；Windows 使用无替换 write-through rename。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
