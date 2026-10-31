---
description: "`ctx.fs` 文件系统服务约定：面向选择或挂载文件系统后端的部署方，以及实现后端的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs

[English](README.md) | 中文

## 概述

使用 `dsh-fs` 可在本地、受限和 SSH 执行环境中一致地访问文件。消费方可解析稳定身份、读取文本或有界字节、列出目录、监听目标、写入文件、应用字面量编辑或补丁 hunk、删除文件，以及移动文本文件并按需打补丁。可选版本防护拒绝陈旧变更。移动分别报告目标发布和源删除。为所选环境挂载提供方；面向模型的工具由 `dsh-tool-fs` 单独提供。

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

普通宿主文件选择 [`fs-local`](../fs-local/README.zh.md)，会话变更必须限制在工作区与临时根目录内时选择 [`fs-sandbox`](../fs-sandbox/README.zh.md)。挂载任一后端都会填充 `ctx.fs`；更换后端不会改变策略插件、工具或工具 schema。未挂载任何后端的组合就没有 `ctx.fs`，工具会在注册时失败。

### 服务能做什么

通过 `ctx.fs` 可解析路径、读取文本或有界字节、列出直接子项并执行受防护变更。`patchText` 在版本检查的同一把锁内应用解析后的 hunk。`deleteFile` 删除普通文件。`moveFile` 锁定两端，按需修改源文本，发布目标后再删除源。防护是可选的：省略时无条件修改当前状态。失败携带运行时列表 `FS_ERROR_CODES` 中的稳定 `FsError` 错误码，传输校验器复用该列表。

`watch(target, changed, signal)` 报告单个文件或目录直接子项的失效通知。观察就绪后，它返回调用方必须等待完成的异步关闭函数。signal 取消初始化；不支持监听的提供方直接拒绝，不使用轮询。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释约定背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该约定建立在一个分离与三项承诺之上：

- **约定高于机制。** 服务只命名存储层能做什么——解析、stat、读取、列出、监听、写入、编辑、应用补丁、删除、移动——绝不规定如何存储字节。后端拥有目标身份、执行世界坐标、解码、二进制拒绝与原子性。
- **策略不放在基类上。** 已观察状态、编辑前读取与版本防护的变更是插件（`dsh-fs-observation-policy`）的职责，通过提供可选防护来添加——因此沙箱化或远程后端不会继承任何面向模型的观察策略。
- **`editText` 留在 seam 上。** 版本校验、字面量匹配与原子重写共享同一个临界区，错误归因与一方胜出/一方陈旧的并发语义因此保持正确；远程后端也可以将其实现为原生比较并编辑操作。
- **界限制在此 seam 上。** `readBytes` 要求 `maxBytes`，并以 `FS_TOO_LARGE` 失败而不是截断，因此任何后端都不会无界缓冲文件。`readByteRange` 则以窗口为界：后端最多传输所请求的 `length` 字节（外加为到达 `offset` 而跳过的前缀），因此由调用方对 `length` 的上限承担防护。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务定义：抽象 `FileSystem` 类、`ctx.fs` 声明与 `fs/*` 事件词汇 |
| [`src/types.ts`](src/types.ts) | 词汇：`FsTarget`/`FsTargetKey`、`FsVersion`、`FsObservation`、`FsWriteIntent`、`FsError` 及其错误码 |

### 调用流程

每个操作使用 `resolve(path, { cwd })` 返回的目标；别名共享不透明身份。跨能力坐标由提供方提供。单文件变更拥有版本检查和原子发布。移动按字典序获取两端目标锁，按相反顺序释放；目标发布与源删除仍是两个独立效果。

### `fs/*` 策略事件

本包声明四个由消费方与观察策略共享的事件。意图 waterfall 由一个决策方负责；观察记录同步执行并携带不透明参与者。调用方在变更前分派对应意图，之后记录已完成的效果。

| 事件 | 用途 |
|---|---|
| `fs/write-intent` | 写入与移动目标的防护。 |
| `fs/edit-intent` | 字面量编辑、补丁与移动源的防护。 |
| `fs/delete-intent` | 删除源的防护。 |
| `fs/observed` | 补丁/写入：存在及版本；删除：缺失；移动：目标存在，仅在源已删除时记录源缺失。 |

### 不变式

- `targetKey` 与 `version` 是带品牌的不透明 id：消费方不得解析或解释它们；只有 `displayPath` 用于模型/UI 输出。
- 读取、列出与变更操作的失败是携带稳定错误码的类型化 `FsError`，绝不是临时拼写的消息字符串；监听初始化可以用普通异常拒绝。
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

- 字面量编辑、补丁与移动要求 UTF-8 文本；删除也接受二进制普通文件，并对其返回 `before: null`。
- 移动是两个效果而非一个事务：`sourceDeleted: false` 表示目标已发布、源仍存在。
- 已解析目标会跟随符号链接；拒绝符号链接源的调用方在 `resolve` 前使用 `lstat`。复制和递归目录操作不在此 API 范围内。
- **没有 I/O deadline**：该 seam 不启动超时；取消只是每个原语上尽力而为的可选 `AbortSignal`（见[fs 能力族立场](../README.zh.md)）。
- **先解析后操作使远程后端每次工具调用需要两次往返**：折叠或缓存解析由这种后端自行决定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
