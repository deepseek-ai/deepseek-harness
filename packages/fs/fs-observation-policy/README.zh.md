---
description: "编辑前读取的文件系统策略插件：面向选择或排查受防护写入/编辑行为的部署方与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-observation-policy

[English](README.md) | 中文

## 概述

`dsh-fs-observation-policy` 在 `ctx.fs` 文件系统约定（[`dsh-fs`](../fs/README.zh.md)）之上添加编辑前读取策略：它记录调用会话观察过哪些文件，并用该记录防护每一次写入与编辑——未见文件只能被创建，已观察文件只能在最后看到的版本上被替换，编辑则要求先读取。它只通过 `fs/*` 事件参与，因此不注册任何服务，也没有公开方法；移除它只会让工具回到裸提供方的无条件变更行为，而不会破坏工具。把它与后端（`fs-local`、`fs-sandbox`）和工具（`tool-fs`）一起加载，会让模型在读取文件之前无法成功编辑文件，并收到清晰的恢复提示。需要 agent（智能体）先读后改的部署请选择它。

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

当部署希望模型在覆盖或编辑文件之前先读取该文件时，把本插件与 `ctx.fs` 后端及 `dsh-tool-fs` 工具一起加载。插件无需配置，也不注入任何服务；它只监听工具分派的 `fs/*` 事件。

### 最小组合

先加载后端，再加载本插件，最后加载工具。策略监听器应当是 `fs/*` 意图槽位上第一个注册的决策器。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

### 对模型而言的变化

挂载策略后，`write` 可以创建新文件，但拒绝覆盖会话未读取过的现有文件；`edit` 要求先读取目标；自读取以来发生变化（包括缺失）的文件以 `FS_STALE_VERSION` 失败。缺失也会被记录：读取缺失文件会把它标记为确认缺失，因此随后的 `write` 可以通过防护创建流程重新创建它。会话恢复后不携带任何已观察状态，因此必须重新读取文件，防护变更才能再次成功。

### 失败与恢复

没有先前观测的编辑以代码 `FS_NOT_OBSERVED` 和消息 `edit requires reading "<path>" first` 失败；编辑被观测为缺失的目标以 `FS_NOT_FOUND` 失败。工具会追加恢复指令——先重新读取文件再重试——同时保留错误码。在外部删除的文件上遵循该恢复指令会记录缺失，因此下一次防护写入可以重新创建它，而不会覆盖并发创建者。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释策略插件背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

插件建立在两个想法之上：

- **事件门禁，而非方法服务。** 插件只通过 `fs/*` 事件影响外部世界，因此不注册 `ctx.fsPolicy` 服务，也没有公开方法。移除它不会在服务注入边界破坏 `dsh-tool-fs`——工具会直接落到裸提供方。
- **已观察状态是先前观察记录。** 一张以所有者为弱键、记录各目标的映射表持有三种逻辑状态——未见、确认缺失、存在于某个版本。插件本身不执行任何文件系统 I/O；它把记录的状态转换为提供方的可选防护，由提供方执行原子新鲜度检查。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 三个 `fs/*` 监听器与已观察状态门禁 |
| [`src/types.ts`](src/types.ts) | 不透明事件参与者形态，从中派生所有者会话 |

### 决策流程

`fs/write-intent` 把未见或确认缺失解析为 `{ kind: 'createIfAbsent' }`，把已观测存在解析为 `{ kind: 'replaceIfVersion', version: vObserved }`。`fs/edit-intent` 以 `FS_NOT_OBSERVED` 拒绝未见目标，以 `FS_NOT_FOUND` 拒绝确认缺失的目标，否则提供观察到的版本作为比较并交换的基础。`fs/observed` 为该所有者与目标记录 `{ kind: 'present', version }` 或 `{ kind: 'absent' }`——同步、只有副作用的 `WeakMap.set`，因为成功的变更已经提交。

### 单槽、先到者胜

每个意图槽位只容纳一个决策器：本插件会完整决策，绝不调用 `next()`。槽位按注册顺序先到者胜——由本插件拥有槽位只是默认部署约定，不是事件强制的不变式。分层权限、审计或沙箱拦截属于 `tools/execute` waterfall（瀑布式事件）。

### 生命周期

已观察状态在插件 dispose（资源释放）时丢弃（HMR 安全），且绝不跨会话持久化——恢复的会话从无观察状态开始。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从策略逐步进入它所组合的约定、工具与后端。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [dsh-fs](../fs/README.zh.md)——`ctx.fs` 约定与 `fs/*` 事件词汇。
- [tool-fs](../tool-fs/README.zh.md)——分派 `fs/*` 事件的面向模型工具。
- [fs-local](../fs-local/README.zh.md)——本策略所防护的宿主文件系统后端。
- [fs-sandbox](../fs-sandbox/README.zh.md)——与本策略组合的沙箱强制后端。
- [Fsspec 风格 seam 拆分笔记](../../../.agents/notes/implemented/simplification/2026-06-26-fsspec-style-fs-seam.zh.md)——策略为何是事件插件而非提供方方法。

-----

<a id="model-experience"></a>
## 模型体验

### 文件系统工具结果

#### 模型看到的内容

该插件不添加提示词或 schema。没有先前观测时，它会以代码 `FS_NOT_OBSERVED` 和精确消息 `edit requires reading "<path>" first` 拒绝编辑；编辑被观测为缺失的目标返回 `FS_NOT_FOUND`。正向观测陈旧时，带防护的变更会传播由提供方拥有的 `FS_STALE_VERSION` 错误。[`dsh-tool-fs`](../tool-fs/README.zh.md) 拥有面向模型的错误包装，会为 `FS_STALE_VERSION` 消息追加恢复指令（`— re-read the file, then retry`）、为 `FS_NOT_OBSERVED` 消息追加恢复指令（`— read the file, then retry`），同时保留错误码。外部删除目标后，遵循陈旧恢复指令会记录缺失：下一次带防护的写入可以通过 `createIfAbsent` 重新创建该目标，而提供方会以原子方式保留任何并发创建者写入的文件。

#### Token 影响

允许的操作除了普通工具结果外不增加 token。拒绝会添加少量保留的错误结果，并避免产生成功 payload。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本策略何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用文件系统对比或任务积压。

- **已观察状态无法在会话恢复后保留**：该记录的持久化工作延期处理，因此恢复的会话必须重新读取文件，才能执行防护写入与编辑。
- **没有 agent（智能体）会话的参与者绝无法满足策略**：它们的编辑会抛出 `FS_NOT_OBSERVED`，写入总会解析为 `createIfAbsent`，因此非 agent 调用方无法通过门禁覆盖现有文件。
- **直接 `ctx.fs` 读取不会发出 `fs/observed`**：在 `read` 工具之外读取的文件仍未观察；后续防护编辑会以 `FS_NOT_OBSERVED` 拒绝，直到工具读取该文件。
- **授权依据是版本新鲜度，而非视图完整性**：任何窗口读取都会授权对未变文件执行全文件覆盖，这有意弱于完整视图规则（见[seam 拆分笔记](../../../.agents/notes/implemented/simplification/2026-06-26-fsspec-style-fs-seam.zh.md)）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。
