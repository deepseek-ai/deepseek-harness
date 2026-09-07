---
description: "工具结果 spill 策略：部署如何用预览和可检索的 spill 文件把过大的纯文本工具结果挡在模型上下文之外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-policy

[English](README.md) | 中文

## 概述

`dsh-spill-policy` 把过大的纯文本工具结果挡在模型上下文之外：当最终结果超过 `maxInlineBytes` 时，它通过 `ctx.spillStore` 保存完整文本，并把面向模型的结果替换为有界的首尾预览、后端定位信息与取回指引，模型可据此读取或搜索 spill 文件。它不注册任何服务，也不负责存储或预览机制——存储由已挂载的 `SpillStore` 后端负责，预览来自 `dsh-output-retention`；它只决定何时 spill 并组合通知。它是可选且尽力而为的：省略 `maxInlineBytes` 时完全禁用，spill 失败时原始结果仍然可见。第二条分支把同样的上限应用到 `run_code` 子调用结果的持久日志副本，因此回放与 UI 也不会无限增长。

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

把策略与 spill 后端一起挂载，以限制模型看到的工具纯文本结果大小。上限作用于工具运行后的最终结果；策略放过的结果仍会原样通过。

### 最小配置

以 UTF-8 字节计的 `maxInlineBytes` 预算加载策略，并同时挂载 spill 后端：

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInlineBytes` | 省略 | 纯文本结果面向模型的上下文上限（UTF-8 字节）；省略时完全禁用该策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-spill-policy)是每个受支持字段的穷尽式真源。负数或小数上限会让插件加载失败，而不是破坏每次调用的行为。

### 模型看到什么

过大的纯文本结果会在同一预算内被替换为预览加通知，因此整个替换内容永远不会超过 `maxInlineBytes`：

```text
<retained head/tail preview>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

当通知本身已占满预算（上限极小或定位信息很长）时，预览为空，只返回通知；如果连这也会超过上限，策略会保留原始内联结果——上限内的替换内容总比原始结果小。完整文本仍保留在 spill 文件中，成功的替换只改变面向模型的副本，绝不改变规范的程序化结果。

### 哪些结果会受影响

策略只作用于最终、已接受且纯文本的结果。不超过上限的结果、包含任何非文本块的结果、嵌套复合调用、`read` 结果、被阻止的决策与已接受的值替换都会原样通过。此前已经发生的提供方级截断（例如 `web-fetch-http.maxBodyChars`）无法在此恢复——spill 文件保存的是工具实际返回的内容。

### 尽力而为的故障行为

缺少会话所有者、缺少 `ctx.spillStore` 后端或 `saveText` 拒绝时，会记录警告并返回原始结果。spill 失败绝不会把成功的调用变成错误，也绝不会隐藏内联结果。

### 持久日志副本

同样的上限也约束每个 `run_code` 子调用结果的会话日志副本：程序仍会收到完整值，只有日志副本被替换为预览与定位信息。过大的 `read` 子调用结果在此同样设界，因为日志副本不是模型上下文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该策略背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该策略刻意保持狭窄：它只决定**何时** spill，并组合通知。它不注册服务、不负责存储、也不负责预览机制——`dsh-output-retention` 的 `TextRetainer` 负责构建首尾预览。两个不变式塑造了代码：面向模型的替换永远不会超过 `maxInlineBytes`（先为通知预留字节成本），且 spill 失败永远不会改变工具调用的结果。

### 两条分支

`tools/post-execute` waterfall（瀑布式事件）监听器（以 `prepend` 注册、通过 `next()` 委托）约束面向模型的结果；`tools/ptc-dispatch-log` 监听器约束每个 `run_code` 子调用的持久日志副本。两者共享同一个替换辅助函数，因此两个投影字节一致。post-execute 分支跳过 `read` 以避免 read → spill → read 循环；dispatch-log 分支约束 `read` 子调用，因为日志副本不是模型上下文。

<a id="shared-notice-ownership"></a>
### 共享通知的所有权

浏览器安全入口 `@deepseek-ai/dsh-spill-policy/notice` 同时负责生产方使用的 `formatSpillNotice(omitted, ref)` 和展示消费方使用的 `hasSpillNotice(text)`。格式化与识别共用通知分隔符；省略信息通过现有的 `describeOmitted` 格式化函数校验，而非复制一套文案。识别支持预览之后或单独出现的完整末尾通知，并保留持久化通知的原有拼写。它只读取已记录的文本，不改写文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 校验、两个 waterfall 监听器、共享替换辅助函数 |
| [`src/notice.ts`](src/notice.ts) | 浏览器安全的通知格式化与识别，以 `./notice` 发布 |
| [`src/types.ts`](src/types.ts) | `SpillPolicyExec`：策略读取所属会话 id 所需的最小结构化工具执行视图 |
| — | 不发布运行时不变式伴生入口；约定在 seam 处强制执行。 |

### 故障模式

两条分支都适用尽力而为降级：没有会话所有者、没有后端、保存被拒绝或没有上限内的替换时，记录警告并保留原始内容。加载时校验会拒绝负数或小数 `maxInlineBytes`，让错误配置失败在部署阶段，而不是让每次超大调用都失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [spill 存储服务](../spill/README.zh.md)——策略替换背后的 `saveText` 约定。
- [dsh-spill-local](../spill-local/README.zh.md)——保存 spill 文本的本地后端。
- [dsh-output-retention](../../util/output-retention/README.zh.md)——策略组合的预览机制（`TextRetainer`）。
- [工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——能力边界与设计依据。

-----

<a id="model-experience"></a>
## 模型体验

### 过大的纯文本结果

#### 模型看到什么

不超过 `maxInlineBytes` 的结果、嵌套结果、`read` 结果、被阻止的决策与包含非文本块的结果保持不变。过大的纯文本面向模型结果会变成有界的首尾预览，后面附加 `(Omitted <bytes> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`；存储或归属失败时原始结果仍然可见。

#### Token 影响

成功的替换最多为 `maxInlineBytes` 个 UTF-8 字节，并保留在历史中直到压缩（compaction）；完整 spill 文本不会重新发送给模型。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明策略在哪些情况下无法提供帮助。它们是当前的包约束。

- **文本识别无法认证输出来源**——工具也能打印相同的通知文本；`hasSpillNotice` 识别的是文本约定，不能证明策略保存过结果。
- **只能对最终纯文本结果执行 spill**——混合内容结果、阻止反馈与 `read` 会原样通过；此前已经发生的提供方截断或工具自有保留无法在此恢复。
- **通知无法容纳时会禁用该次调用的替换**——上限极小或定位信息很长时，后端已经保存了无引用的 spill，但过大的原始结果仍留在内联位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性。

#### 未来：逐工具配置

逐工具选择退出或逐工具策略声明仍然延期；内置的 `read` 跳过已覆盖已知循环，第二个真实工具需求才能证明配置的合理性。

#### 未来：更早的 spill

该策略只能看到最终格式化文本，因此已被提供方截断或只以运行时产物形式存在的内容（例如 bash 流或 subagent 展开）仍在触达范围之外；通过 `ctx.spillStore` 实现的工具自有早期 spill 仍然延期。

</details>
