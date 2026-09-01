---
description: "spill 存储服务：部署方与插件作者如何保存过大的工具文本并取回可检索的定位信息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill

[English](README.md) | 中文

## 概述

`dsh-spill` 让任何插件或工具都能通过 `ctx.spillStore` 保存过大的文本，并拿到一个不透明定位信息、精确的字节数与模型可以直接依据的取回指引。它定义 spill 后端做什么，而不规定如何存储——部署需要挂载 `dsh-spill-local` 之类的后端才能真正持久化，由 `dsh-spill-policy` 插件决定工具结果何时过大。当部署必须在不让模型上下文泛滥的前提下保留超大工具输出时，选择它。该服务只负责存储：没有保留策略、没有工具结果替换，也没有取回或搜索 API。真实存储故障会以拒绝结束，由调用方决定如何降级。

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

需要 spill 工具输出的组合会挂载一个 spill 后端——仅本包本身不存储任何内容——并由 `dsh-spill-policy` 插件决定何时 spill。插件与工具作者直接调用 `ctx.spillStore.saveText()`，在当前会话下持久化文本。

### 何时选择

当部署需要在模型只看到有界预览之后仍可检索超大的工具输出时，选择 spill 存储——例如模型稍后可能想读取或搜索的抓取页面正文。当组合中没有工具会产生大到值得处理的输出，或部署没有模型工具可读取的本地文件系统时，你不需要本包；此时需要的是一个在该环境中定位信息有明确含义的后端。

### 最小可用组合

把后端与策略一起挂载；设置 `maxInlineBytes` 后，任何过大的纯文本工具结果都会自动变成预览加定位信息。

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

### 保存文本

挂载后端后，用所属会话、来源描述、建议文件名与完整文本调用 `ctx.spillStore.saveText()`：

```text
const ref = await ctx.spillStore.saveText({
  owner: { sessionId: 'session-1' },
  source: { toolName: 'web_fetch', callId: 'call-1', label: 'result' },
  suggestedName: 'web_fetch.txt',
  content: fullText,
})
```

返回的 `SpillRef` 携带三个字段：`locator`，后端产生的不透明模型面向句柄（对 `dsh-spill-local` 是本地文件路径，对其他后端可能是 URI 或键）；`bytes`，写入的精确 UTF-8 字节数；`retrievalHint`，消费方展示给模型的指引——对本地后端而言是读取或搜索该路径。消费方按指引渲染定位信息，绝不自行解析定位信息。

### 归属与边界

存储按所属会话分组：fork 后的会话从种子日志继承既有定位信息，无需复制或更改归属，fork 后新产生的 spill 使用子会话 id。`suggestedName` 只是提示——后端会把它清理成单个安全路径段，绝不把它当作可信路径。该服务刻意排除其他包负责的内容：保留与预览决策（`dsh-output-retention`）、何时 spill（`dsh-spill-policy`），以及取回或搜索（后端的 `retrievalHint` 会告诉模型如何处理定位信息）。

### 故障与恢复

`saveText` 只在真实存储故障时拒绝——权限不足、磁盘已满或后端不可用。由调用方决定如何降级：随附策略把拒绝当作尽力而为处理，记录警告并保留原始内联结果，因此 spill 失败绝不会把成功的工具调用变成错误或隐藏内容。如果没有挂载后端，就没有可保存的目标；请在组合中加载 `dsh-spill-local` 或其他后端。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该服务背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在一个分离与刻意的极简之上：

- **约定、实现与策略保持分离。** 本包定义后端做什么（`saveText`）；`dsh-spill-local` 实现它；`dsh-spill-policy` 决定何时触发。各项关注点独立演进与替换。
- **只有一个方法，别无其他。** 该 seam 不负责保留策略、结果替换或取回/搜索 API——那些都有各自的归属包。
- **在 seam 处拒绝，绝不静默降级。** 降级由调用方负责；seam 报告真实存储故障。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `SpillStore` 服务及其 `saveText` 约定 |
| [`src/types.ts`](src/types.ts) | 词汇：`SaveTextSpill`、`SpillRef`、带品牌类型 `SpillLocator`、`SpillOwner`、`SpillSource` |
| — | 不发布运行时不变式伴生入口；约定在 seam 处强制执行。 |

### 数据模型

`SaveTextSpill`（owner、source、suggestedName、content）是请求；`SpillRef`（locator、bytes、retrievalHint）是结果。`SpillLocator` 是带品牌类型的字符串，消费方无法在未获后端意图的情况下把它当作路径；`SpillOwner.sessionId` 是保存时存储命名空间，`SpillSource` 记录产生 spill 的工具、调用 id 与标签，用于可读文件名——仅作描述，绝非访问控制。

### 生命周期

后端继承 `SpillStore` 并以插件方式加载，注册为 `ctx.spillStore`；每个上下文只有一个实现，第二次加载会失败。dispose 会释放该服务。抽象类本身不注册任何内容——本包只提供约定与词汇。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入已交付后端、策略与设计依据。

- [spill 子系统](../../../docs/subsystems/spill.zh.md)——穷尽式词汇、归属与后端关系。
- [spill 包映射](../README.zh.md)——三包家族与各自职责。
- [dsh-spill-local](../spill-local/README.zh.md)——已交付的本地文件系统后端。
- [dsh-spill-policy](../spill-policy/README.zh.md)——决定最终结果何时过大的策略。
- [dsh-output-retention](../../util/output-retention/README.zh.md)——策略背后的预览机制。
- [工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——能力边界与设计依据。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过把后端定位信息与取回指引渲染给模型的 spill 消费方。

#### KV Cache 影响

无直接失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 spill 存储服务单独使用时在哪些方面不完整。它们是当前的包约束。

- **没有取回或删除 API**——消费方只能渲染后端的定位信息与指引；生命周期与访问语义仍由后端自行决定。
- **存储不等于访问控制**——所属会话区分写入命名空间，但不会授权通过定位信息读取内容；每个后端与取回消费方都必须自行强制执行访问边界。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的探索方向与开放问题。它明确不具权威性。

#### 未来：执行器 spill 文件集成

该 seam 只有 `saveText`；为既有执行器 spill 文件提供保存文件或链接/复制路径（例如规范化 bash 临时文件），以及为 subagent 展开提供工具自有 spill，仍然延期，见[工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)。

#### 未来：非本地后端与清理

面向 ACP 或远程环境的远程或数据库后端，以及旧 spill 文件的清理或保留策略（很可能与会话清理挂钩），仍是开放问题。可预测且任何用户均可读取的 spill 根目录会让其他本地用户读到 spill 工具输出，这正是已交付后端把文件保持私有的原因。

</details>
