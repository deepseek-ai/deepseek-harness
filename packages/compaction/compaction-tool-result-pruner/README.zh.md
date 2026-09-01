---
description: "面向组合压缩的部署方的工具输出修剪：选择大小限制或排查超大工具结果为何被缩短。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-tool-result-pruner

[English](README.md) | 中文

## 概述

`dsh-compaction-tool-result-pruner` 防止上下文窗口被超大工具输出填满。压缩即将运行时，它会把每个超出预算的工具结果修剪为长度受限的头部、简短的「middle pruned」标记与长度受限的尾部，同时完整原始结果仍保留在会话日志中，可供精确回放与检查。修剪不发起模型调用，并可能自行清除 token 压力，因此压缩可能完全跳过摘要。它只在压缩触发条件满足后运行——低于压力的对话绝不会被触碰。字符预算只是启发式；token meter 负责判定压力是否真的得到缓解。

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

当工具输出经常主导对话窗口时，在 `dsh-compaction-basic` 旁挂载本包。修剪会改变模型看到的内容——更短的结果——并让压缩有更少的历史需要压缩。

### 最小可用组合

按此顺序挂载 token 测量、本包与后端：

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
- name: '@deepseek-ai/dsh-compaction-basic'
```

有了这些配置行，超大工具结果会在压缩过程中自动被修剪。你可以通过检查后续请求是否显示修剪后的结果来确认成功；完整原始内容仍保留在会话日志中。

### 什么会被修剪

每个文本超过阈值的工具结果都会被替换为修剪版本：配置的头部、简短的「middle pruned」标记与配置的尾部。图片与结构化块等富内容保持原有顺序。替换保留工具调用、步骤、错误与元数据——只有文本内容发生变化。如果替换无法被记录，运行会失败，已应用的修剪仍会保留。

### 设置大小限制

所有设置都可选；默认会把文本超过 8,192 个字符的结果修剪为其前 4,096 加后 1,024 个字符，并用标记连接。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-tool-result-pruner)是穷尽式真源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `thresholdChars` | `8192` | 合并文本超过此 Unicode 码点数时修剪。 |
| `headChars` | `4096` | 保留的开头 Unicode 码点数。 |
| `tailChars` | `1024` | 保留的末尾 Unicode 码点数。 |

字符数以 Unicode 码点计，因此切片绝不会拆分 emoji 对，但多字符字素仍可能被切断。头部加标记加尾部之和必须不超过阈值，因此有效配置可以修剪每个超出预算的结果，不会增长或重复改写。未知设置会在构造时拒绝插件。

### 修剪何时运行

修剪只在压缩触发条件满足后运行：`dsh-compaction-basic` 在压力或溢出确认后、选择要压缩的内容之前调用它。低于压力时不会修剪任何内容，修剪本身也不发起模型调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释修剪器背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该修剪器建立在三项承诺之上：

- **确定性的单次收敛。** 按 Unicode 码点以固定预算切片，因此每个发出的结果在文本码点上都精确包含已配置的头部、标记与尾部，不大于 `thresholdChars`，且严格小于触发输入。
- **可安全回放的替换。** 原始事件保留在仅追加日志中；替换通过 `sourceEventSeqs` 引用它，因此回放可以恢复产生已剪枝结果的精确输入。
- **影子价格协议。** `compaction/prune` 紧跟其替换，通过注入的 token meter 为被替换的精确范围定价，使纯消费方无需每节点状态即可减去它——即 `compaction/prune` 事件上记录的共享协议。

### 剪枝机制

剪枝按 Unicode 码点测量 `text` 块（非文本块计为零），生成长度受限的替换——内容已在预算内时则不替换——并把每个超出预算的工具结果换为一条新追加的 `tool/result`，该事件替换原始事件并通过 `sourceEventSeqs` 引用它，前面紧跟一条 `compaction/prune` 影子价格事件。会话拒绝替换时，运行会同步失败；本次扫描中先前已提交的替换仍会保留。非文本块保持原始相对位置，切片绝不会拆分 UTF-16 代理项对。精确签名见 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ToolResultPruner` 服务、`pruneSession` / `pruneContent` / `measureContent` |
| [`src/config.ts`](src/config.ts) | `PRUNE_MARKER`、默认值、码点计数、预算验证 |
| [`src/types.ts`](src/types.ts) | `ToolResultPruneConfig`、`ResolvedConfig`、`PrunedEntry`、`PruneResult` |
| — | 不发布运行时不变式伴生入口；替换可在会话日志中观察。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从消费后端逐步进入共享 seam 与定价服务。

- [压缩基础后端](../compaction-basic/README.zh.md)——在压缩前修剪超大工具输出的后端。
- [压缩 seam](../compaction/README.zh.md)——本包接入的压缩约定。
- [压缩子系统参考](../../../docs/subsystems/compaction.zh.md)——压缩词汇、结果与服务行为。
- [Token meter](../../llm/token-meter/README.zh.md)——判定修剪是否缓解压力的测量服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-tool-result-pruner)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 已剪枝的工具结果

#### 模型看到的内容

一旦满足压缩触发条件，后续请求看到的将是保留的头部、`\n\n[... tool result middle pruned ...]\n\n` 和保留的尾部，而非被移除的文本。非文本块保持原有顺序。模型不会看到原文的第二份副本。

#### Token 影响

每个已改写工具结果最多包含 `thresholdChars` 个文本码点。剪枝本身不会发起模型调用；重新测量的请求低于压力阈值时，compaction-basic 会跳过摘要，否则摘要器会读取已剪枝的表层。

#### KV Cache 影响

替换较早的结果会使从第一个改变的 token 起的复用失效。当其路由、envelope 与之前的历史保持一致时，已剪枝前缀可以复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明修剪何时不合适，或何时需要特别注意；它们是当前包约束。

- **字符预算不是 token 预算**——不同提供方的 token 密度各异，因此 `ctx.tokenMeter` 仍负责判定修剪是否缓解了请求压力。
- **剪枝只基于语法**——它保留开头与结尾，不解释中间哪些行在语义上重要。
- **字素簇可能被拆分**——按码点切片可保护代理项对，但不会执行感知区域设置的字素簇分割。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **语义化中间选择，尚未决定**——剪枝盲目保留头部与尾部；判断中间哪些行重要需要模型或结构化启发式，两者都未随附。
- **基于 token 的预算，暂缓**——预算以 Unicode 码点计；改为基于 token 的预算需要 token meter 未暴露的估算器约定。

</details>
