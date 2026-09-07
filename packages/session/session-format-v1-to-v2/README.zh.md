---
description: "冻结的已发布 v1 Session 读取器，以及把 Assistant 流嵌入已发布 v2 事件的基数变化迁移。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v1-to-v2

[English](README.md) | 中文

## 概述

`dsh-session-format-v1-to-v2` 通过一个有状态事件 Stage，把已发布 v1 Session 转换为已发布 v2 事件模型。它会消费顶层 `assistant/chunk` 事件，把精确的带时间流嵌入匹配的 `assistant/message`，并在失败、重试、取消或 stream error attempt 已到达 settlement、但没有产生 surface message 时记录 `assistant/attempt`。该迁移边会密集重映射存活事件和每个已声明的同 Session 序号引用；v2 codec 则让每行只存一个事件，并从带标记的 `session/end-seed` 事件推导继承切点。

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

### 何时使用

持久化通过 `dsh-session-format-catalog` 获取该迁移边；功能组合不会挂载它。只有在装配或测试静态已发布格式目录，或检查精确的 v1 到 v2 转换时，才直接导入本包。它不发布运行时不变式伴生入口，因为本包没有状态可能彼此分歧的、可独立观测的运行时注册项；decoder 与 transformer 状态只属于一次还原。

### 入口

```text
const decoder = releasedV1SessionFormatCodec.createDecoder(physicalHeader, 'strict')
for (const row of physicalRows) decoder.decodeRow(row, migrationContext)
const stage = sessionFormatV1ToV2.createStage(stageInput)
stage.transformEvent(event, migrationContext)
const targetInheritedEventCount = stage.finish(migrationContext)
const headerRecord = releasedV2SessionFormatCodec.encodeHeader(currentHeader, targetInheritedEventCount)
const eventRecord = releasedV2SessionFormatCodec.encodeEvent(currentEvent)
```

`releasedV1SessionFormatCodec` 逐行读取冻结的 v1 物理语言。`sessionFormatV1ToV2` 创建改变事件基数的 Stage，静态 catalog 把它连接到 decoder，且不保留 v1 事件数组。Catalog 会重映射已声明引用，并校验 released-v2 envelope、inherited cut、事件准入与关系。持久化在发布前通过 Worker 执行完整 installed-current 校验。`releasedV2SessionFormatCodec` 创建当前格式的逐行 decoder，并逐条编码当前 header 与事件。

成功的 v1 `assistant/message` 必须引用其完整有序 attempt。迁移会移除这些顶层 chunk 和已停用的 message provenance，在不合并 token 边界的前提下压缩 chunk，并把 stream 存到该 message 上。未被 message 认领的 attempt 会在其最后一个 chunk 的位置变成一个仅日志可见的 `assistant/attempt`。无关的交错事件保持相对顺序。

该 edge 还会闭合一种有限的旧版恢复模式：非空的 `next-turn` inbox 插入后直接出现下一个 `turn/start`，但缺少前一轮的 `turn/end`；迁移将前一轮记录为 interrupted。旧版 round-zero goal mutation 会变成一个 `goal/change`，随后保留原本模型可见的 message 并改用普通 plugin attribution，因此持久 goal 状态与历史模型输入都会保留。

如果引用指向被消费的 chunk，迁移会失败，而不会把它重定向到语义不同的事件。它会重映射已声明的事件 provenance、surface replacement、command source event、compaction range 与 list，以及 title message list。已经对模型可见的 `session/title-llm-request.messages` 文本会在源校验后保持逐字节不变，因此目标校验不会重新解释该 prompt 中嵌入的旧序号。带 seed 的源若让继承切点切开一个 Assistant attempt，也会迁移失败；目标会用 `session/end-seed { inherited: true }` 标出精确切点。

v2 物理 header 要求 `isSeeded`，且不存储数值切点。编解码器从最后一个 inherited end-seed marker 推导切点，每行写入一个事件，只对 `sourceEventSeqs` 做范围编码，并对普通事件词汇与 payload 扩展保持中立。Released-current restoration 准入 installed Session package 已知的事件 type，以及携带 `ignorable: true` 的未知事件，并校验事件 member 与关系。普通 Session restore 只检查 runtime 直接依赖的 settlement 字段，不重放嵌入 stream；persistence publication 与冻结的 writer-image fixture validator 保留完整 stream verification。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

增量迁移边会保留一个尚未结算的 Assistant attempt、输出位置取决于该 attempt 的事件，以及密集的旧序号到新序号映射。它按源顺序发出已结算的存活事件，并且只重写冻结事件清单声明的引用字段。Released-current 校验会拒绝转换无法保留的任何关系。

| 文件 | 职责 |
|---|---|
| [`src/migration.ts`](src/migration.ts) | Attempt 分组、settlement 替换、密集序号映射与引用重写 |
| [`src/codec.ts`](src/codec.ts) | 已发布 v2 header、每行一个事件的编码、provenance 范围与可恢复前缀解码 |
| [`src/validation.ts`](src/validation.ts) | v2 物理 envelope／cut 校验，以及 released-current 事件准入与关系校验 |
| [`src/dispositions.ts`](src/dispositions.ts) | 冻结的已发布 v2 事件与 payload 成员清单 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [已发布 v0 到 v1 迁移边](../session-format-v0-to-v1/README.zh.md)——本包复用的源编解码器与冻结历史词表。
- [静态目录](../session-format-catalog/README.zh.md)——构建拥有的编解码器与迁移顺序。
- [Session 持久化子系统](../../../docs/subsystems/persistence.zh.md)——不可变 generation 选择与发布。
- [嵌入式 Assistant stream 决策](../../../.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.zh.md)——理由、替代方案与后果。

-----

<a id="model-experience"></a>
## 模型体验

### 历史还原

#### 模型看到什么

成功的 Assistant message 会保留从同一 v1 stream 组装出的 content、provider、model、usage 与 replay state。失败或放弃的 attempt 会通过 `assistant/attempt` 保留为持久诊断事实，但不会进入 `deriveMessages()`。

#### Token 影响

迁移不会添加模型可见内容。它会保留派生 message history，只从当前逻辑事件序列中移除顶层 chunk 信封。

#### KV Cache 影响

还原后的模型 message 序列保持不变，因此迁移本身不会改变请求前缀的缓存身份。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **封闭的第一方源清单**——未知 v1 事件会使迁移失败，包括带有 `ignorable: true` 的事件。
- **线性重映射状态**——流式处理不保留完整 v1 事件数组，但最终 v2 事件数组和旧到新序号映射仍为 O(事件数)。
- **不负责发布或兼容回退**——持久化拥有排他 successor 发布，保留的 v1 generation 不是自动 downgrade 或 restore 输入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
