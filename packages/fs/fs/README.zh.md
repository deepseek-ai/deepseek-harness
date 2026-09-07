---
description: "`ctx.fs` 文件系统服务约定：面向选择或挂载文件系统后端的部署方，以及实现后端的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs

[English](README.md) | 中文

## 概述

`dsh-fs` 定义 `ctx.fs` 文件系统服务：一个紧凑、与后端无关的约定，面向同一个执行世界，把路径解析为稳定身份、在受支持时映射共享宿主文件、在界内读取文本与原始字节、列出目录，并原子地执行写入与字面量编辑。它有意把存储机制留给实现它的后端——`fs-local` 面向宿主文件系统，`fs-sandbox` 面向策略强制的隔离，`fs-e2b` 面向远程执行世界。两个变更操作都带可选版本防护，因此即使不加载策略插件，挂载的后端依然提供完整、不受约束、原子的文件操作。本包还拥有由工具包分派、策略插件决策的 `fs/*` 策略事件词汇。当你需要可替换的文件系统表面时选择它；面向模型的工具本身位于 `dsh-tool-fs`。

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

你很少直接加载 `dsh-fs`：你挂载一个注册为 `ctx.fs` 的后端，然后从自己的插件调用该服务，或让 `dsh-tool-fs` 工具替你调用。本页服务于确实接触它的两类读者——选择后端的部署方，以及实现或消费该约定的开发者。

### 选择并挂载后端

普通宿主文件选择 [`fs-local`](../fs-local/README.zh.md)，会话变更必须限制在工作区与临时根目录内时选择 [`fs-sandbox`](../fs-sandbox/README.zh.md)，文件状态必须位于远程执行世界时选择 [`fs-e2b`](../../e2b/fs-e2b/README.zh.md)。挂载任一后端都会填充 `ctx.fs`；更换后端不会改变策略插件、工具或工具 schema。未挂载任何后端的组合就没有 `ctx.fs`，工具会在注册时失败。

### 服务能做什么

通过 `ctx.fs`，你可以把任意路径解析为稳定的目标身份、完整读取或分片流式读取文本文件、按显式上限读取原始字节、列出一层目录、原子地创建或替换文件，并原子地应用字面量文本编辑。两个变更操作上的版本防护都是可选的：省略它即无条件创建或覆盖，提供它则在文件自上次观察以来发生变化时失败。每个操作要么返回数据，要么抛出携带稳定错误码（如 `FS_NOT_FOUND`、`FS_STALE_VERSION`、`FS_AMBIGUOUS_EDIT`）的类型化 `FsError`，调用方依据错误码分支，绝不解析消息文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释约定背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该约定建立在一个分离与三项承诺之上：

- **约定高于机制。** 服务只命名存储层能做什么——解析、stat、读取、列出、写入、编辑——绝不规定如何存储字节。后端拥有目标身份、执行世界坐标、解码、二进制拒绝与原子性。
- **策略不放在基类上。** 已观察状态、编辑前读取与版本防护的变更是插件（`dsh-fs-observation-policy`）的职责，通过提供可选防护来添加——因此沙箱化或远程后端不会继承任何面向模型的观察策略。
- **`editText` 留在 seam 上。** 版本校验、字面量匹配与原子重写共享同一个临界区，错误归因与一方胜出/一方陈旧的并发语义因此保持正确；远程后端也可以将其实现为原生比较并编辑操作。
- **界限制在此 seam 上。** `readBytes` 要求 `maxBytes`，并以 `FS_TOO_LARGE` 失败而不是截断，因此任何后端都不会无界缓冲文件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务定义：抽象 `FileSystem` 类、`ctx.fs` 声明与 `fs/*` 事件词汇 |
| [`src/types.ts`](src/types.ts) | 词汇：`FsTarget`/`FsTargetKey`、`FsVersion`、`FsObservation`、`FsWriteIntent`、`FsError` 及其错误码 |

### 调用流程

每个普通操作都以 `resolve(path, { cwd })` 开始，它产生稳定的 `FsTarget`（不透明 `targetKey` 加用于模型/UI 输出的 `displayPath`）；经不同路径到达同一文件会产生相同 key。`processPathFromHostPath(hostPath)` 在后端共享或显式映射宿主文件时，单独把绝对宿主文件映射进此执行世界，否则返回 `undefined`。读取随后执行 `stat` → `readText`/`streamText`/`readBytes`，列出执行 `listDir`，变更则经过每个目标一个临界区：先检查可选防护，应用新内容，再原子发布结果。

### `fs/*` 策略事件

本包声明三个事件，使发出方（`dsh-tool-fs`）与策略监听器（`dsh-fs-observation-policy`）共享词汇，而无需让发出方依赖策略插件。`fs/write-intent` 与 `fs/edit-intent` 是单槽决策 waterfall（瀑布式事件）：第一个监听器直接决策，绝不调用 `next()`。`fs/observed` 是发后即忘的记录事件，携带 `FsObservation`——存在并带版本，或确认缺失。事件只携带 `dsh-fs` 词汇和一个不透明 `object` 参与者。

### 不变式

- `targetKey` 与 `version` 是带品牌的不透明 id：消费方不得解析或解释它们；只有 `displayPath` 用于模型/UI 输出。
- 失败是携带稳定错误码的类型化 `FsError`，绝不是临时拼写的消息字符串。
- 该 seam 不设 I/O deadline；取消是每个原语上可选的 `AbortSignal`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从穷尽式约定逐步进入构建于其上的后端与消费方。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [fs-local](../fs-local/README.zh.md)——实现该约定的宿主文件系统后端。
- [fs-sandbox](../fs-sandbox/README.zh.md)——实现该约定的沙箱强制后端。
- [tool-fs](../tool-fs/README.zh.md)——消费 `ctx.fs` 的面向模型工具。
- [fs-observation-policy](../fs-observation-policy/README.zh.md)——通过 `fs/*` 事件防护变更的策略插件。
- [能力 seam 笔记](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)——文件系统栈为何拆分为约定、提供方、策略与工具。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-fs` 间接产生影响；该消费方把提供方文本和错误渲染为有界且保留的文件系统工具结果。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该约定何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用文件系统对比或任务积压。

- **变更操作约定只支持文本**：文本读取和两个变更操作都以 `FS_NOT_TEXT` 拒绝二进制/非 UTF-8 内容；`readBytes` 是唯一的原始字节原语，二进制安全的变更操作仍延期。
- **只有十三个原语**：没有删除、重命名、复制或监视；`listDir` 只列出一层，递归、glob、分页与搜索不在范围内（见[目录列出笔记](../../../.agents/notes/archived/architecture/2026-07-03-filesystem-directory-listing-seam.md)）。
- **没有 I/O deadline**：该 seam 不启动超时；取消只是每个原语上尽力而为的可选 `AbortSignal`（见[fs 能力族立场](../README.zh.md)）。
- **先解析后操作使远程后端每次工具调用需要两次往返**：折叠或缓存解析由这种后端自行决定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
