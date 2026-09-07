---
description: "spill 存储服务：保存超大工具文本或已捕获的会话引用，并返回可检索的定位信息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill

[English](README.md) | 中文

## 概述

`dsh-spill` 让任何插件或工具都能通过 `ctx.spillStore` 保存过大的文本，并拿到一个不透明定位信息、精确的字节数与模型可以直接依据的取回指引。它定义 spill 后端做什么，而不规定如何存储——部署需要挂载 `dsh-spill-local` 之类的后端才能真正持久化，由 `dsh-spill-policy` 插件决定工具结果何时过大。当部署必须在不让模型上下文泛滥的前提下保留超大文本时，选择它。该服务只负责存储：没有保留策略、没有工具结果替换，也没有取回或搜索 API。真实存储故障会以拒绝结束，由调用方决定如何降级。

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

保存 spill 产物的组合需要挂载一个后端——仅本包本身不存储任何内容。`dsh-spill-policy` 决定工具结果何时 spill；`dsh-session-reference` 直接保存被截断引用的转录，不需要该策略。调用方使用 `ctx.spillStore.saveText()` 并明确指定归属；可选消费方通过 `ctx.get("spillStore")` 获取后端。

### 何时选择

当部署需要在模型看到有界预览后仍能取回全文时，选择 spill 存储，例如抓取的页面正文或已捕获的会话引用转录。前提是后端的定位信息与取回指引在部署环境中可用；该服务不要求本地文件系统访问。

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
  source: { kind: 'tool', toolName: 'web_fetch', callId: 'call-1', label: 'result' },
  suggestedName: 'web_fetch.txt',
  content: fullText,
})
```

返回的 `SpillRef` 携带三个字段：`locator`，后端产生的不透明模型面向句柄（对 `dsh-spill-local` 是本地文件路径，对其他后端可能是 URI 或键）；`bytes`，写入的精确 UTF-8 字节数；`retrievalHint`，消费方展示给模型的指引——对本地后端而言是读取或搜索该路径。消费方按指引渲染定位信息，绝不自行解析定位信息。

### 归属与边界

存储按所属会话分组：fork 后的会话从种子日志继承既有定位信息，无需复制或更改归属，fork 后新产生的 spill 使用子会话 id。会话引用产物归接收上下文的目标会话所有，而不是被引用的源会话。`suggestedName` 只是提示——后端会把它清理成单个安全路径段，绝不把它当作可信路径。预览与 spill 决策由消费方负责；存储与产物过期由后端负责。

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

`SaveTextSpill` 将存储归属与描述性来源信息分开。`SpillSource` 接受工具来源 `{ kind: "tool", toolName, callId, label }` 或 `{ kind: "session-reference", sessionId, label }`，后者的 id 标识被捕获的源会话。会话引用绝不伪造工具调用 id。来源信息与归属命名空间都不授予读取权限。消费方把返回的定位信息视为不透明值，并与取回指引一同展示。

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

远程或数据库后端仍是开放方向。本地后端执行其[启动清理策略](../spill-local/README.zh.md#startup-cleanup)；该服务未定义按会话清理或刷新定位信息的 API。

</details>
