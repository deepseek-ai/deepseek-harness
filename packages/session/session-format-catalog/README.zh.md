---
description: "供持久化读取方使用的构建期静态第一方 Session 格式编解码器与相邻迁移装配。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-catalog

[English](README.md) | 中文

## 概述

`dsh-session-format-catalog` 为持久化提供一个确定性的 Session 格式读取器，且无需查询已挂载插件。它把冻结的 v0、v1 与 v2 编解码器和相邻的 v0 到 v1、v1 到 v2 迁移边装配起来，在模块初始化时校验完整且无缺口的迁移链，并通过 `sessionFormatCatalog` 暴露物理分派、仅 header 分类、单遍行还原和当前格式逐记录编码。

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

当持久化与测试支持读取方需要在任何功能插件挂载前取得完整第一方已发布格式清单时，导入本库。功能组合不会注册或重排其条目。它不发布运行时不变式伴生入口，因为构造过程会拒绝无效静态清单，每次完成的还原也会校验结果；可变行 decoder 状态只属于一次由调用方持有的流式还原。

### 入口

```text
const descriptor = sessionFormatCatalog.readHeader(physicalHeader)
const restore = sessionFormatCatalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' })
for (const row of physicalRows) restore.decodeRow(row)
const current = restore.finish()
const headerRecord = sessionFormatCatalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
const eventRecords = current.events.map(sessionFormatCatalog.encodeCurrentEvent)
```

从包根导入 `sessionFormatCatalog`。JSONL 与 fixture 读取方创建一次 restore，把每个已解析物理行传给 `decodeRow()`，再调用一次 `finish()`。Writer 通过 `encodeCurrentHeader()` 与 `encodeCurrentEvent()` 序列化返回的当前 artifact。列表读取调用 `readHeader()`，绝不打开事件正文。

Production 历史读取使用 `{ recovery: 'recoverable', validation: 'transformed' }`。Worker 与 fixture 校验使用 `{ recovery: 'strict', validation: 'current' }`。Transformed validation 会在迁移后执行已发布 current 规则，但对已经是 current 的输入有意跳过已安装语义校验。

该目录直接包含所有受支持的历史读取器。Profile 无法通过挂载功能插件来添加、移除或重新排列迁移边。它通过对 `dsh-session` 的 peer 依赖获得已安装的当前事件词表与当前还原规则，而历史迁移边校验器保持冻结。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`src/generated.ts`](src/generated.ts) 是编解码器与迁移边顺序的静态所有者。[`src/current.ts`](src/current.ts) 把最终标头、事件信封、消息、表面、种子和当前请求标头校验委托给已安装的 Session 语义。底层构造函数会在开始读取任何 Session 之前拒绝重复编解码器、重复迁移边、缺口，以及超过当前版本的条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [迁移机制](../session-format/README.zh.md)——目录构造与分派行为。
- [已发布 v0 到 v1 迁移边](../session-format-v0-to-v1/README.zh.md)——编解码器与校验器所有权。
- [已发布 v1 到 v2 迁移边](../session-format-v1-to-v2/README.zh.md)——Assistant stream 嵌入与基数变化引用重映射。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md)——不可变 generation 命名与排他发布。

-----

<a id="model-experience"></a>
## 模型体验

### 目录分派

#### 模型看到什么

没有直接内容。该目录只还原由请求重建逻辑消费的 `SessionEvent` 历史。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

没有直接影响；还原后的历史在其消费者中决定缓存身份。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅包含第一方构建清单**——尚不支持外部迁移所有权与分发。
- **生成顺序封闭**——运行时插件注册无法补充缺失的历史迁移边。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
