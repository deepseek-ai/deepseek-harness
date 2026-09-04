---
description: "面向部署方与维护者的随产品交付 JSONL 会话持久化后端说明，用于选择、配置或排查带可选 Zstandard 压缩的逐会话持久日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

[English](README.md) | 中文

## 概述

`dsh-session-persistence-jsonl` 把每个会话存为当前的仅追加 JSONL 日志，并保留不可变的历史格式 generation——默认以带校验和的 Zstandard 帧存储，禁用压缩时以换行分隔的原始文本行存储。它通过持久化句柄提供当前逻辑 `SessionEvent` 流，因此格式迁移、压缩、历史解码与崩溃恢复仍是存储内部细节。当消费方需要按会话的磁盘文件时选择它；选择 `compression: 'none'` 后日志可作为纯文本按行读取。根目录是唯一必填配置；持久性、延迟实体化、已发布 v0/v1 迁移与撕裂尾部崩溃恢复都随后端提供。

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
| `compression` | `'zstd'` | 物理编码：`'zstd'` 带校验和帧，或 `'none'` 换行分隔 UTF-8 文本 |

实时事件的写入批处理不是配置：批处理窗口是该 seam 在每个写句柄内部的调度策略。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-jsonl)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 磁盘布局

每个会话在可读项目目录下获得一个会话自有目录。每个规范 generation 都以版本与文件名一致的物理 header 开始。当前 v2 为每个持久事件存储一行；冻结的 v0 与 v1 reader 也能理解其历史 packed Assistant delta 行。V2 在 header 中存储 `isSeeded`，并从最后一个带标记的 `session/end-seed` 推导 inherited cut；历史 codec 则转换其数字 `seedLength`。格式 catalog 会在句柄暴露当前逻辑值之前完成该转换。当前存储记录使用下文所述的无损来源序列表示：

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # released v0, compressed root
      session.v1.jsonl.zstd      # released v1, compressed root
      session.v2.jsonl.zstd      # released v2, compressed root
      session.jsonl              # released v0, raw root
      session.v1.jsonl           # released v1, raw root
      session.v2.jsonl           # released v2, raw root; later versions use vN
```

会话 id 在使用前被单射转义为一个安全路径段（无遍历、无冲突）。规范化 cwd 让项目目录保持可读、便于导航；规范化相同的 cwd 字符串共享项目目录，而会话 id 仍选择不同会话目录。runtime 操作选择数值最高的规范 generation，格式拒绝诊断会点名该绝对路径，让操作者能找到构建拒绝解读的原始日志。

### 持久性与崩溃语义

会话延迟实体化：`create(header)` 不写入任何内容并返回持有的写句柄，句柄的第一次 `append` 通过无覆盖发布写入并 `fsync` 编码后的 header 与第一批——因此已创建但从未 append 的会话不留下任何磁盘内容，除非其所有者调用 `handle.flush()`，以无事件的单个 header 帧发布它。后续每个批次追加行或一个压缩帧，并在 append 完成前 `fsync`；捕获到写入或同步失败时把文件回滚到之前的字节长度。已提交事件绝不重写。崩溃后，已存储日志保留被中断的最终轮次——已提交前缀中的每条记录都保留下来，由执行恢复的读方通过其写句柄追加合成 closer。撕裂尾部——不完整的最后一行，或撕裂的最后一帧——绝不返回给读取方并被整体丢弃，在写句柄的第一次新 append 之前被持久截断，因为其自身的 append 从未成功返回，其中没有任何内容被确认为已持久；已提交前缀中的校验和、解压或结构失败以损坏拒绝。

### 读取日志

`open(id, 'read'|'write')` 选择最高规范 generation，并在返回句柄前为受支持的历史源发布一个并列的当前后继；源保持逐字节不变。句柄的 `read(offset?, length?)` 随后提供经过验证的连续切片，绝不包含撕裂尾部。撕裂的最终 Zstandard 帧会被部分解码：其中已刷入的完整 JSONL 记录被恢复进逻辑日志，写句柄的第一次修改会截掉当前 generation 的撕裂字节并在自己的批次之前持久重写这些恢复的记录。写 open 会用已验证的存储前缀预热句柄，一个按 revision 为键的有界 memo 让紧接的观察到恢复交接复用该解析。`stat(id)` 与 `list()` 只选择并转换最高 generation 的 header，不读取事件行，也不发布迁移输出；快照携带所选文件的 `sizeBytes` 与尽力而为的 stat 派生修订号。选择 `compression: 'none'` 后，日志是外部读取方可直接消费的换行分隔文本；压缩默认值必须经后端读取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明物理编码与写入路径；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

该后端拥有自己完整的存储运行时（`src/storage.ts`）：`JsonlSessionHandle` 承载逐句柄修改链、带固定批处理窗口与 single-flight 排空的已路由实时事件缓冲、单调读取与幂等 close；一个 tracker 持有进程内单写者认领、teardown 清扫所遍历的打开句柄集合，以及后端自己的会话监听器所路由进的已创建但未实体化待定会话。本包有意只暴露默认插件导出与配置类型——具体类不是具名导出，因此消费方只耦合 `ctx.sessionPersistence`，其可观察行为由共享 seam 测试套件（`runPersistenceContract`/`runLiveWritePathContract`）钉住。其变更令牌是尽力而为的文件修订值：device、inode、size 与纳秒时间戳标识一份日志，供 `stat`/`list` 以及在并发 append 撕裂读取时重试的稳定读取循环使用。

### 物理编码

默认产物是独立 [Zstandard 帧](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md) 的标准拼接：一个仅包含 header 行的带校验和帧，后跟每个持久 append 批次一个带校验和帧，使用 Node 内置 Zstandard API 的默认压缩级别（无级别开关）。当前 v2 为每个事件写一行；`sourceEventSeqs` 使用无损存储形式：至少包含三个序列号的连续段会变成 `[start, end]` 区间对，其他列表原样保留；读取时会展开回精确的内存数组。列表只读取并验证 header 帧。`compression: 'none'` 保留相同的存储形式逻辑行，但不使用帧压缩。一个根只属于一种编码：启动发现与定向查找会拒绝使用另一后缀的 generation；格式迁移保留已配置编码，而压缩转换、混合根回退与双写仍不受支持。冻结的 v0 与 v1 codec 仅为历史 generation 保留 packed-row decoder。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、后端服务类与文件存储原语 |
| [`src/storage.ts`](src/storage.ts) | JSONL 句柄、已路由实时事件缓冲、进程内写入者记账、监听器、teardown |
| [`src/format.ts`](src/format.ts) | 日志路径派生、header 编码与当前记录扫描 |
| [`src/generation.ts`](src/generation.ts) | 稳定 generation 读取、格式 adapter 调用、排他后继发布与已提交 reopen |
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
- [已发布 Session 格式迁移](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)——不可变 generation、相邻迁移边与发布规则。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

JSONL 存储不会向实时请求提供提示词或 schema。加载会恢复已存储的表层历史，并保留之前的请求 header 用于重建；新 loop 组合当前 envelope。恢复会用 `TOOL_NOT_STARTED` 平衡没有持久调用的 assistant 请求；持久调用无结果时则变为 `TOOL_OUTCOME_UNKNOWN`，它要求模型只重试只读或幂等工作，并验证可能的副作用或询问用户。嵌入式 Assistant stream 与仅日志 attempt 不会重复生成消息。

#### Token 影响

实时请求不新增 token。恢复后的 agent（智能体）会因保留的历史、当前 envelope，以及每个中断调用中以引用形式加入的修复结果文本而消耗 token。

#### KV Cache 影响

JSONL 存储不修改实时请求前缀。只有重建历史、当前 envelope 与模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **格式迁移保留已配置编码，且只支持 catalog 中的链**——本 build 把已发布 v0 或 v1 迁移到当前 v2；更改压缩需要独立根，保留的前任不提供自动 fallback 或 downgrade 支持。
- **平铺文件存储布局不加载**——加载前使用独立根，或将预发布产物移入项目/会话目录布局。
- **压缩文件不能直接按行读取**——使用后端加载；或在写入新根前选择 `compression: 'none'`，供外部行读取方使用。
- **不删除会话文件**——日志在 `root` 下累积，直到外部移除；seam 无删除接口。
- **每会话一个活动写入方**——写句柄认领在所属后端实例内排除第二个写入方，内核锁（`session.lock` 上的非阻塞 `flock(2)`；Windows 上为由该路径派生的命名内核信号量，零文件系统足迹）排除其他所有实例与进程；锁在写打开既有工件时立即获取，新建会话则仅在首次物化写入之前获取，因此未物化的会话不留任何文件系统足迹。崩溃持有者的锁随其进程消亡，会话立即可再写入，而活着但卡死的持有者会阻塞写入方直到其进程退出（POSIX 上删除锁文件即放弃该排他；释放本身从不删除它）。咨询式 `flock` 在部分网络文件系统（NFSv3）上不可靠，Windows 信号量名按登录会话隔离。
- **POSIX 实体化需要硬链接支持**——第一次 append 使用 `link()`，使同 id 竞态失败而不覆盖已提交日志；Windows 使用无替换 write-through rename。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
