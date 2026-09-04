---
description: "冻结的已发布 v0 Session 标头、事件与打包行解码器，以及到 v1 的恒等转换。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v0-to-v1

[English](README.md) | 中文

## 概述

`dsh-session-format-v0-to-v1` 解码完整的已发布 v0 JSONL 记录语言，并把它转换为共享布局的 v1 格式。除把 `version: 0` 改为 `version: 1` 外，该迁移边会保留经过校验的标头与事件事实；它也会应用 v0 持久化曾接受的有限旧格式规范化。该包冻结 v0 读取器、严格的 v1 迁移目标校验器，以及不冻结事件词表的 v1 物理编解码器，使后续迁移边无需导入最新 Session 表示即可复用它。它的大部分源码是冻结的已发布 v0/v1 事件词表而不是恒等转换本身：`payload-validation.ts` 与 `relationships.ts` 钉住每种第一方事件类型的 payload 成员与生命周期配对，使畸形历史日志在已安装的 current 恢复器运行之前就以「不支持的迁移」被拒绝并保留源文件，也使后续重构已发布事件的迁移边无需导入当前 Session 包即可信任其形状。

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

持久化通过 `dsh-session-format-catalog` 获取该迁移边；功能组合不会挂载它。只有在装配或测试静态已发布格式目录时，才直接导入本包。它不发布运行时不变式伴生入口，因为每次 codec 与迁移调用都会校验完整的源或目标 artifact，且不保留运行时状态。

### 入口

```text
const decodedV0 = releasedV0SessionFormatCodec.decodeArtifact(header, rows)
const migratedV1 = sessionFormatV0ToV1.migrate(decodedV0)
```

`releasedV0SessionFormatCodec` 读取精确的 v0 标头与物理行，包括打包的 Assistant 增量和范围编码的来源序号。`sessionFormatV0ToV1` 规范化并严格校验一个完整且分离的产物。`releasedV1SessionFormatCodec` 在不冻结普通事件词表的前提下保留 v1 物理布局；目录会根据已安装的 Session 包还原当前事件。

Alpha 迁移边会拒绝冻结清单之外的所有事件类型，包括带有 `ignorable: true` 标记的未知事件。它也会拒绝意外的 payload 成员。`tool/result.meta` 与嵌套 PTC `arguments` 是显式的不透明 JSON 字段；迁移会原样保留它们，不把其中的数字解释为 Session 序号。未知 content-block `type`、message-source `kind`、assistant finish-reason `kind` 与 `turn/end` reason `kind` 分支保持 owner-opaque JSON，已知分支则接受结构校验。

有限的历史规范化会把 `steering/message` 转换为 `user/message`、移除 `turn/start.trigger`、转换已停用的 `turn/end` reason、添加当前消息包装层与确定性的旧消息 id，并移除已停用且重复的 `request/header.header.messagePrefix`。已停用的 `request/header-delta`、`mode/set` 和 `request/header` fallback reason 会使迁移失败。除此之外，任何事件、引用、来源或 payload 事实都不得改变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

物理编解码器会以行为原子单位展开每个打包行，且绝不修改已解析输入。可恢复解码会回滚完整的故障行并保留此前前缀，除非后续成功解码的 `turn/end` 证明故障区域已经提交。迁移会先校验冻结的 payload 处置，再更改标头版本，并再次校验精确的 v1 目标。

| 文件 | 职责 |
|---|---|
| [`src/codec.ts`](src/codec.ts) | 冻结的 v0/v1 物理标头、打包行与来源序号范围 |
| [`src/dispositions.ts`](src/dispositions.ts) | 已发布 v0 事件与 payload 成员清单 |
| [`src/payload-validation.ts`](src/payload-validation.ts) | 每种已发布 v0/v1 事件类型的冻结嵌套 payload 语义 |
| [`src/relationships.ts`](src/relationships.ts) | 冻结的跨事件配对：轮次、步骤、工具开始与结果、重试、压缩、标题 |
| [`src/migration.ts`](src/migration.ts) | 恒等迁移边与旧格式规范化 |
| [`src/validation.ts`](src/validation.ts) | 精确的源与目标校验 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [迁移机制](../session-format/README.zh.md)——纯迁移链与编解码约定。
- [静态目录](../session-format-catalog/README.zh.md)——构建拥有的装配。
- [Session 子系统](../../../docs/subsystems/session.zh.md)——当前逻辑 Session 语义。

-----

<a id="model-experience"></a>
## 模型体验

### 历史还原

#### 模型看到什么

没有直接内容。还原后，`deriveMessages()` 会看到在 v1 下保持不变的规范已发布 v0 事件；有限历史结构会通过规定的当前包装层产生相同的模型可见内容。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

对规范 v0 历史没有直接影响。有限 normalizer 会在生成当前包装层与确定性标识时保留模型可见内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **封闭的第一方清单**——按照当前 Alpha 策略，未知的外部插件事件会使迁移失败。
- **单个相邻迁移边**——本包不执行发布，也不选择后续迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
