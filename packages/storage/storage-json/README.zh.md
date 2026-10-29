---
description: "JSON 存储后端：面向在配置根目录下选择、配置或排查整单元文件与逐记录文件的宿主与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-json

[English](README.md) | 中文

## 概述

`dsh-storage-json` 在配置的根目录下把领域数据存为可读 JSON，并注册为后端 `json`。默认的 `single` 布局为每个单元保存一份完整的 `<unit>.json` 文件；`per-record` 布局为每条记录保存一份带版本戳的文档。两种布局都以原子方式发布每个变更文件，领域层负责安排调用顺序。当运维方需要可检查文件且所选布局适合写入量时选择它；对于更大且频繁更新的单元则选择 SQLite。本后端只面向宿主侧，不贡献提示词、工具或 schema。

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

当组合需要可读、可编辑的 JSON 存储时使用本包。把相关领域路由到 `json` 后端；每个领域规范选择 `single` 或 `per-record` 布局。

### 何时选择

小型单元需要一份完整、美化打印的文件时，选择默认的 `single` 布局。可丢弃记录的定点写入只需替换一份文档时，选择 `per-record`；不支持或不可读的文档会读作不存在。大型单元需要频繁定点更新时，选择 SQLite。领域 API 在两种后端上都没有多记录事务操作。

### 配置

唯一的插件字段是 `root`，用于保存单元文件与目录。它是必填项，因为本后端不回退到 `process.cwd()`。后端按需以 `0o700` 模式创建根目录。领域规范选择其布局；本插件不提供布局覆盖项。

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 保存 `<unit>.json` 文件与 `<unit>/` 目录树的目录；按需以 `0o700` 创建 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-storage-json)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可观察行为

没有旧文件引导时，缺失的 `single` 文件或 `per-record` 目录会作为空单元打开，并在第一次写入时物化。在 `single` 中，畸形内容以 `malformed-medium` 拒绝，已存版本不在当前版本和 `compatibleVersions` 集合内时以 `version-mismatch` 拒绝。读取接受的旧文件时保持原状；下一次原子写入使用当前版本戳，保留已声明表中未改动记录的原值。删除不存在的键或空批次不会重新盖戳。在 `per-record` 中，每份畸形或不可读的文档，以及版本不在接受集合内的文档，都读作记录不存在，因此单个坏文档不会使单元被拒绝。版本拒绝不会删除文档。逐记录布局的键必须匹配 `[a-zA-Z0-9_-]+`；不安全的键在任何文件操作前被拒绝。写入完成后即已持久化；`per-record` 删除在完成前会在 POSIX 上同步目录变更。在完成前中断的批次可能只应用一部分。无法恢复可读或持久状态的批量删除以 `unknown-state` 拒绝，之后除 `close()` 外的所有操作都会拒绝；关闭后的调用以 `closed` 拒绝。

只有当源单元名称匹配，且源版本为当前版本或已声明的兼容版本时，尚未物化的 `per-record` 目录树才可以从有效的 `<root>/<unit>.json` 整单元文档初始化其已声明表。该引导会在加载时写入：它保持源文件不变，并把已存值复制到当前版本戳的文档中，不转换其中的值。接受集合之外的源版本会使新目录树保持为空。只要存在任意已声明表的目录（即使为空），或已声明的 `global.json`，就会对整个单元禁止该初始化。因此删除的记录会保持缺失，同时保留的源文件不变。

同步序列化失败会恢复已打开 `single` 单元先前的内存状态，允许在同一句柄上重试。I/O 失败可能发生在文件替换之后，因此写入被拒绝并不能证明磁盘数据或版本戳保持不变。必须停止使用并关闭后端及其领域，然后重新打开以加载已存状态，再决定是否重试。混合记录与降级行为参阅[领域版本](../../../docs/subsystems/storage.zh.md#domain-versioning)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两种布局共享原子发布机制，但以不同方式确定状态所有权。`single` 拥有一份内存单元投影；`per-record` 把目录树视为权威状态。

### 设计理念

- **`single` 以内存为权威状态。** 每次写入都会更改内存单元、序列化其完整状态，并以原子方式替换 `<unit>.json`。批量删除只发布一次。序列化失败会恢复所有受影响的内存值；I/O 结果不确定时必须重新打开，不能继续使用该快照。
- **`per-record` 以目录为权威状态。** 每次 put 或 delete 都会更改一个 `<unit>/<table>/<key>.json` 文档，`loadAll()` 则重新读取目录树。每份文档都带有单元版本戳与一条记录值。批量删除先把整批文档改名移出可读集合，在 POSIX 上同步目录，然后删除暂存副本。暂存或同步失败时会恢复文档，并同步恢复后的目录；恢复或同步失败时该 unit 以 `unknown-state` 拒绝，之后除 `close()` 外对它的所有操作都会拒绝。
- **每次调用都持久发布。** 写入过程使用临时文件、fsync、原子 `rename()` 替换，并在 POSIX 上 fsync 父目录。领域层写入链负责安排跨调用的顺序。

### 文件格式

`single` 文档携带单元标识、全局单例与所有表：

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } }
}
```

`per-record` 表文档位于 `<root>/<unit>/<table>/<key>.json`，形式为 `{ "version": 1, "record": <value> }`；可选的全局值使用 `<root>/<unit>/global.json`。格式版本来自领域规范。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：后端注册、`root` 配置、单元打开／关闭表 |
| [`src/single-unit.ts`](src/single-unit.ts) | 一个 `single` 单元：权威内存、写入原语与发布回滚 |
| [`src/per-record-unit.ts`](src/per-record-unit.ts) | 一个 `per-record` 单元：目录树读取、路径安全记录与单文档写入 |
| [`src/format.ts`](src/format.ts) | 带版本校验的整单元与记录序列化 |
| [`src/atomic.ts`](src/atomic.ts) | 原子文件替换：临时文件写入、fsync、rename、目录 fsync |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本后端视角不够用时阅读以下页面：子系统参考是权威约定，兄弟后端展示了另一种介质。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——后端约定、领域语义与生成的 API。
- [存储包映射](../README.zh.md)——家族的各包及其在仓库中的位置。
- [SQLite 存储后端](../storage-sqlite/README.zh.md)——面向高频数据的定点更新介质。
- [领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——后端家族背后的设计及其延期工作。

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

- **`single` 会重写整个单元**——每次写入都重新发布完整单元文件；当此成本过高时，使用 `per-record` 或把领域路由到 SQLite。
- **没有跨进程写锁**——两个进程写入同一单元时可能交错执行替换；对同一文件的写入以最后完成者为准。
- **Windows rename 没有显式 write-through**——持久性依赖 libuv 的 `rename()`（`MoveFileExW` 并启用替换）；`log` 分面落地时，计划把会话日志后端更严格的 Win32 write-through 发布辅助函数下移到此处。
- **`per-record` 批次不保证崩溃原子性**——删除完成前崩溃可能留下部分批次与 `.deleting` 残留。已完成的删除会在 POSIX 上同步暂存后的目录变更；清理残留不可读。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

Agent Note 把整单元重写的规模前提标记为风险：如果在被路由到 SQLite 之前，第二个消费方以千条记录规模落到本后端，重写成本会比预期更早显现。缓解办法是配置——把 `routes` 指向 SQLite 后端——而不是修改本包。

</details>
