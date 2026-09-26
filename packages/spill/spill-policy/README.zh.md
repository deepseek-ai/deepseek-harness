---
description: "工具结果保留：文字和图片共享 token 预算，并通过完整结果文件恢复省略内容。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-policy

[English](README.md) | 中文

## 概述

将过大的文字和图片结果限制在共享的估算 token 预算内。模型收到按原顺序保留的首尾内容，以及完整结果文件的路径。图片保存在附件存储中，结果文件记录其可读取路径。省略 `maxInlineTokens` 会禁用策略，无法保存可恢复内容时保留原结果。

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

将策略与 spill 后端一起挂载。执行后策略接受结果之后，文字和图片共享配置的预算。

### 最小配置

挂载 spill 后端，并以估算 token 数设置 `maxInlineTokens`：

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineTokens: 12500
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInlineTokens` | 省略 | 保留的文字、图片、图片说明和提示的估算 token 上限；省略时禁用策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-spill-policy)是每个受支持字段的穷尽式真源。负数或小数上限会让插件加载失败，而不是破坏每次调用的行为。

### 模型看到什么

过大的结果保持原始顺序。扣除省略提示后，两端各使用剩余预算的一半；文字可以切分，图片整张保留或省略。省略区间中的图片也会被省略。成功替换的内容不超过配置的 token 估算预算：

```text
<retained head/tail preview>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

提示也会报告省略的图片数量。预算容不下预览时允许只返回提示；连提示也超出上限时保留原内容。完整结果文件保存全部已接受文字，并在每张图片的位置记录附件路径，模型可先用 `read` 读取，再用 `read_image` 查看。图片字节不复制到这个文件中。本地附件对象的持久保存独立于 spill 文件清理。

### 哪些结果会受影响

策略接受文字和图片序列。预算内结果、`read`、被阻止的决策、值替换以及其他内容块类型会原样通过。纯文本嵌套结果只限制日志副本。提供方或工具在此前应用的限制无法在这里恢复。

### 尽力而为的故障行为

缺少归属或 spill 后端、存储失败、缺少模型图片计量或图片路径无法在执行环境读取时，策略记录警告并保留原内容。策略不会用无法读取的路径替换图片。

### 持久日志副本

PTC 程序收到完整的规范值。含图片的子结果在转发给模型前设定上限；全部图片被省略时，模型仍会收到保留的文字和读取提示。分发日志使用相同的保留内容。纯文本子调用的日志，包括 `read`，异步设定上限，不延迟程序获取返回值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该策略背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

纯保留函数按成本选择有序内容，插件负责策略、读取提示和存储调用。文字使用现有 token-meter 估算。图片使用当前模型的 `imageRequestPricing`，并计入说明文字。DeepSeek 模型复用提供方的图片尺寸计算器。预算是估算值，不保证与实际分词结果完全一致。

### 两条分支

以 prepend 注册的 `tools/post-execute` 监听器先委托，再限制已接受的内容。`tools/ptc-dispatch-log` 共用同一辅助函数。MCP 的 `projectContent` 在这些策略之前安装真实图片块；后续内容替换、值替换或阻止仍然生效。

<a id="shared-notice-ownership"></a>
### 共享通知的所有权

浏览器安全入口 `./notice` 负责 `formatSpillNotice(omitted, ref, images)` 和 `hasSpillNotice(text)`。它识别历史的仅字节提示和包含整张图片数量的提示，不改写已有记录。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 校验、两个 waterfall 监听器、共享替换辅助函数 |
| [`src/notice.ts`](src/notice.ts) | 浏览器安全的通知格式化与识别，以 `./notice` 发布 |
| [`src/retention.ts`](src/retention.ts) | 有序图文首尾保留的纯函数 |
| — | 不发布运行时不变式伴生入口；除在所属 seam 处强制执行的约定外，本包不公开独立的事件序列或可变数据关系。 |

### 故障模式

无法恢复内容或计量失败时保留输入，并记录原因。负数、小数或非安全整数预算会使插件加载失败。包含不支持的内容块类型的结果保持原样。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [spill 存储服务](../spill/README.zh.md)——策略替换背后的 `saveText` 约定。
- [dsh-spill-local](../spill-local/README.zh.md)——保存 spill 文本的本地后端。
- [Token meter](../../llm/token-meter/README.zh.md) — 共享文字估算和模型图片计量。
- [工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——能力边界与设计依据。

-----

<a id="model-experience"></a>
## 模型体验

### 过大的文字和图片结果

#### 模型看到什么

保留的前缀和后缀维持图片顺序，并在省略区间显示 `[...]`。末尾提示说明省略的文字字节数、整张图片数量及完整结果路径。读取该文件可以找到省略的文字和图片地址。

#### Token 影响

成功替换的结果在共享文字估算和当前模型图片计算器下不超过 `maxInlineTokens`，包括提示和图片说明文字。实际用量以提供方报告为准。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明策略在哪些情况下无法提供帮助。它们是当前的包约束。

- **文本识别无法认证输出来源**——工具也能打印相同的通知文本；`hasSpillNotice` 识别的是文本约定，不能证明策略保存过结果。
- **无法恢复或计量**：图片要求模型计算器和执行环境可读取的附件路径，否则保留原内容。不支持的内容块、被阻止的反馈和 `read` 也会原样通过。
- **通知无法容纳时会禁用该次调用的替换**——上限极小或定位信息很长时，后端已经保存了无引用的 spill，但过大的原始结果仍留在内联位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性。

#### 未来：逐工具配置

逐工具选择退出或逐工具策略声明仍然延期；内置的 `read` 跳过已覆盖已知循环，第二个真实工具需求才能证明配置的合理性。

#### 未来：更早的 spill

策略只处理最终已接受的内容。此前的提供方截断和工具自身的输出限制仍由各自负责。

</details>
