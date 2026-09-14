---
description: "面向后端实现者与部署方的共享压缩约定：会话压缩做什么、何时使用，以及如何实现后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction

[English](README.md) | 中文

## 概述

`dsh-compaction` 让长时会话把较早历史压缩（compaction）成一条摘要消息、保持近期对话不变，并像摘要一直存在那样继续下去——配合 `dsh-compaction-basic` 之类的后端与可选的 `/compact` 命令即可实现。被遮蔽的内容仍保留在会话日志中，因此回放会话时能确定性地重现同一份压缩后的对话。当你实现压缩后端、构建触发压缩的组件，或需要识别压缩后的消息时，才需要本包——它本身不执行任何压缩。想开箱即用地获得该功能时，请选择随附后端。

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

先确定你需要什么。随附后端加 `/compact` 命令即可零代码获得自动与按需压缩；只有在你扩展或重实现该功能时才需要本包。以下各节说明压缩做什么、如何启用，以及如何编写后端。

### 何时选择

当模型撰写的摘要符合需求时，选择 `dsh-compaction-basic`：会话增长时自动压缩，并可通过 `dsh-command-compact` 按需压缩。当你需要不同的摘要方式——固定模板或远程服务——或构建以编程方式触发压缩的组件时，选择本包。不要单独挂载它：没有后端就什么都不会压缩。

### 压缩后会发生什么

压缩运行时，所选较早范围的对话会被替换为一条摘要消息；近期历史不受影响，对话从摘要继续。压缩可以由 token 压力自动触发、按需触发，或针对显式范围触发；结果会报告压缩了哪些历史以及估算释放的 token 数。

### 启用压缩

挂载随附后端以注册压缩服务，并添加 `dsh-command-compact` 获得按需命令：

```yaml
- name: '@deepseek-ai/dsh-compaction-basic'
- name: '@deepseek-ai/dsh-command-compact'
```

有了这两行配置，功能即已开启：会话增长时自动压缩，`/compact` 收到请求后立即压缩并报告替换了多少历史项。如果未挂载后端，什么都不会压缩，`/compact` 也会失败；随附后端的完整依赖链见其自身 README。

### 实现后端

继承提供的基类并实现三个操作：一个针对自动触发决定并执行压缩，一个按需压缩，一个压缩对话的显式范围。把你的类作为插件加载，它就会成为该组合的压缩服务。精确签名、失败规则以及每个后端必须生成的检查点标记，见下方实现章节与[压缩子系统参考](../../../docs/subsystems/compaction.zh.md)。

### 识别压缩后的历史

后端写入的摘要消息带有稳定标记，因此任何消费方都能在持久化或克隆后识别压缩历史，而无需知道是哪个后端生成的。该标记从包根导出，也从一个无 Cordis 依赖的子路径导出，客户端与 wire 程序均可导入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节以 API 术语解释约定及其背后的设计决策；功能层面行为见[使用本包](#use-this-package)。

### 设计理念

该 seam 建立在一个拆分与三项承诺之上：

- **抽象约定，具体后端。** 接口规定压缩做什么；提供方拥有策略、保留与摘要，因此各角色可独立演进、独立替换。
- **会话与 LLM（大语言模型）词汇是约定的一部分。** 操作作用于 `Session`，摘要使用 `ContentBlock`，因此尽管有通用的 Cordis-only 指引，Service Definition 仍依赖 `dsh-session` 与 `dsh-llm`——这是一项有意的偏离，记录在[压缩能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md) 中。
- **日志记录的标记对就是锁。** `compaction/start` 在摘要让出控制权之前追加，`compaction/end` 释放；每次失败都恰好进行一次闭合尝试，闭合失败会留下未匹配 start 作为有意的 busy 信号。
- **表层只变更一次。** 摘要承载在标记对内的一条 `user/message` 替换上；所有 `compaction/*` 事件仅写入日志。

### 服务 API

该约定是后端实现的三个抽象操作：`compactIfNeeded` 针对自动 `pressure` 或 `context-overflow` 触发，`compactNow` 进行一次显式按需缩减，`compactRegion` 针对调用方选择的表层范围。可复用的请求测量是独立服务 `ctx.tokenMeter`。穷尽式逐操作语义见[压缩子系统参考](../../../docs/subsystems/compaction.zh.md)；精确签名见 [`src/index.ts`](src/index.ts)。

通过 `ctx.llm.stream()` 摘要的后端必须将 signal 转发到调用的 `GenerateOptions.signal`，因此 abort 或 fiber dispose（资源释放）会停止进行中的摘要。自动和显式范围标记对会从打开的轮次恢复其数字形式归属；手动标记对不要求存在打开的轮次，并标记 `turn: null`。

### 手动失败分类

同步的 `compaction/summary-error` waterfall 让后端为失败的摘要及明确选区请求持久输入恢复。监听器只有在记录实际进展后才返回 true，否则调用 `next()` 委派后续处理。后端在触发事件前检查取消和选区稳定性，重试前重新派生输入并计价。事件声明说明其载荷；图片策略由 `dsh-compaction-image-offload` 负责。

预期手动失败会抛出 `ManualCompactionError`，携带来自小型封闭集合的稳定 `code`；只有 `compaction/start` 标记之后发生的失败才会被记录——以携带错误的 `compaction/end` 形式——而 `busy` 拒绝或 start 之前的取消不会留下记录。每个错误码的语义见[压缩子系统参考](../../../docs/subsystems/compaction.zh.md)。

<a id="tool-pairing-boundaries"></a>
### 工具配对边界

该 Service Definition 导出 `toolPairingBalancedBefore(session, seq)` 与 `toolPairingBalancedAfter(session, seq)`，用于对齐和验证压缩边界。安全边界不会被尚未回答的 assistant 工具调用跨越。每个 helper 都会验证给定事件 seq 位于当前表层，并根据按表层顺序缓存的各切分点配对状态返回结果，因此重复检查不读取事件；replace generation 会重建缓存，缺失 seq 或孤立的 `tool/result` 会被视为表层状态损坏并遭拒绝。

### 表层约定

`SurfaceEventType` 是封闭联合——`user/message`、`assistant/message` 与 `tool/result` 必须携带 `surfaceOp`，其他事件禁止携带该字段，因此 `compaction/*` 事件不能出现在表层上。成功的后端运行改为在日志中包围整个操作：先追加 `compaction/start`（仅日志）获取锁，摘要该范围，追加仅日志的 `compaction/summary` 记录，用一条承载摘要的 `user/message` 替换所选范围——这是唯一的表层变更——最后追加 `compaction/end`（仅日志）释放锁。

替换位于锁的起止范围**内**，因此 `compaction/start` 与 `compaction/end` 之间崩溃会留下可检测的遗留锁，而不是虚假声称成功的 `compaction/end`。`deriveMessages()` 将摘要渲染为 user 角色消息，后面跟随已保留节点；已遮蔽事件仍保留在原始日志中，因此回放具有确定性。每个事件的具体 payload 见[压缩子系统参考](../../../docs/subsystems/compaction.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `CompactionEngine`、`CompactionTrigger`、`ManualCompactionError`、`ctx.compaction` 合并 |
| [`src/types.ts`](src/types.ts) | `CompactionResult` 与声明合并的 `compaction/*` 会话事件 |
| [`src/tool-pairing.ts`](src/tool-pairing.ts) | 两个边界 helper 背后的每会话切分点平衡缓存 |
| [`src/checkpoint.ts`](src/checkpoint.ts) | 无 Cordis 依赖的检查点来源构造函数与谓词（`./checkpoint` 叶子） |
| [`src/brand.ts`](src/brand.ts) | `CompactionId` 品牌化标识 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量配套组件：校验 `compaction/start`→`summary`→`end` 标记对、其属主轮次包裹与检查点关联 |

### 锁与串行化

所有入口点共享一个日志记录的锁。尾部检查会分别查找最新的未匹配 `compaction/start` 与最新的 `session/end-seed`；位于该边界之后的未匹配 start 是活动锁并报告 `busy`，更早的则是先前进程生命周期留下的陈旧证据。活动标记对不能跨越 `turn/start` 或 `turn/end`。标记是锁的时间点，而非排他容器：空闲的 `inject()` 可以在手动 start 与 end 之间追加不相关的上下文，因此手动路径重新验证其选中范围，而不要求整个表层相等。

### 事件

`compaction/*` 事件通过 declaration merging 扩展 `SessionEventMap`（可合并扩展）——它们是会话事件，不是 Cordis `Events`，且都仅写入日志。生成的[持久化日志事件目录](../../../docs/persistence-catalog.zh.md)拥有每个事件的 payload；`compaction/prune` 记录了与工具结果修剪器共享的影子价格协议。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享词汇逐步进入随附后端与决策证据。

- [压缩子系统参考](../../../docs/subsystems/compaction.zh.md)——压缩词汇、结果与生成的 API。
- [压缩基础后端](../compaction-basic/README.zh.md)——自动与按需压缩的随附后端。
- [工具结果修剪器](../compaction-tool-result-pruner/README.zh.md)——先修剪超大工具输出的可选配套工具。
- [面向用户的 /compact 命令](../command-compact/README.zh.md)——按需触发压缩的入口。
- [Token meter](../../llm/token-meter/README.zh.md)——决定何时压缩的测量服务。
- [压缩能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md)——拆分及 session/llm 依赖的依据。

-----

<a id="model-experience"></a>
## 模型体验

### 调用后端时的会话历史

#### 模型看到的内容

成功的后端会用一条 user 角色摘要检查点替换较早表层范围——一条携带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的 `user/message`。原始事件仍会记录，但不再出现在派生模型消息中；seam 本身不执行改写。

#### Token 影响

该 Service Definition 不会直接产生 token。后端用一份摘要换取多个原本保留的历史 token，并保持近期尾部不变。

#### KV Cache 影响

成功的后端替换会使从第一个被遮蔽的历史 token 起的复用失效；seam 本身不会改变请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明无论加载哪个后端，压缩都无法做到的事；它们是当前包约束。

- **面向用户的命令，而非模型工具**——压缩由 `/compact` 命令与自动压力触发；不会注册面向模型的压缩工具。
- **部分单元溢出不在约定内**——平衡摘要压缩无法拆分一个不可分单元。当闭合工具对中可移除的主要部分是承载文本的工具结果时，可选剪枝配套服务仍可修复该工具对；无法压缩大型非工具节点，或不可剪枝剩余部分过大的工具单元。
- **单独接近窗口大小的 envelope 不属于表层压缩工作**——压缩缩减派生历史，绝不缩减系统提示词、工具或会话前缀。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **面向模型的工具，尚未决定**——压缩目前仅限用户命令。面向模型的压缩工具仍是开放问题；它需要自己的 schema，并与现有命令路径协调。
- **模板与远程后端，尚未决定**——`SummaryResult` 约定已带有未标记的 `rawOutput` 变体，供不通过 `ctx.llm.stream()` 识别调用的摘要器使用，但此类后端尚未随附。
- **`/compact` 的范围参数，尚未决定**——无参数形式使各命令适配器的行为保持稳定；显式范围仍由编程接口 `compactRegion()` 处理。

</details>
