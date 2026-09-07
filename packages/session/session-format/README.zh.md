---
description: "纯函数式相邻 Session 格式规划、无损 JSON 值检查、仅标头迁移与物理编解码分派。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format

[English](README.md) | 中文

## 概述

`dsh-session-format` 让持久化代码可以直接还原当前 Session，或在只消费一次物理行的同时组合唯一的相邻迁移序列。一次还原会让调用方拥有的已解析值流经有状态 Stage，不复制或冻结中间 artifact。物理分帧、压缩、不可变 generation 命名、排他发布和 Cordis 生命周期行为不属于本库。

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

当持久化或格式目录代码需要分类物理 Session header、还原当前逻辑值或组合已发布相邻迁移时，使用本库。它不是 Cordis 插件，也没有 profile 挂载行。它不发布运行时不变式伴生入口，因为每个已完成操作都会校验结果；decoder 与 transformer 状态只属于一次尚未完成的流式还原，绝不在多次还原间共享。

### 入口

```text
const catalog = createSessionFormatCatalog({ currentVersion, codecs, currentEncoder, migrations, restoreCurrent, restoreTransformedCurrent, restoreCurrentHeader })
const descriptor = catalog.readHeader(physicalHeader)
const restore = catalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' })
for (const row of physicalRows) restore.decodeRow(row)
const current = restore.finish()
const headerRecord = catalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
const eventRecords = current.events.map(catalog.encodeCurrentEvent)
```

`createSessionFormatCatalog()` 接收每个受支持版本的一个冻结 codec、当前格式的逐记录 encoder、每组相邻版本的一个迁移，以及当前 artifact 与 header 还原器。`readHeader()` 在不读取事件的情况下返回 `current`、`migration-required`、`unsupported` 或 `malformed` 描述符。正文读取方创建一次 restore，把每个已解析物理行传给 `decodeRow()`，再调用一次 `finish()` 获得当前 artifact。写入方逐条编码其 header 与事件。

`recovery` 选项决定严格拒绝故障行，还是执行可恢复后缀处理。`validation: 'current'` 会执行已安装 current 格式的全部校验。`validation: 'transformed'` 会在历史迁移后执行已发布 current 格式校验；已经是 current 的输入则只接受其 codec 的物理校验。

可恢复解码器返回已接受的逻辑前缀。编解码器可以丢弃一个格式错误或序号不连续的行及其未提交后缀，但后续成功解码的 `turn/end` 会使原始问题成为致命错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

迁移链在构造时校验唯一且无缺口的顺序。Catalog 把一个行 decoder 与有状态的相邻事件 transformer 组合起来，只保留其有界状态与最终当前事件，并在 `finish()` 时执行目标校验；只有调用方决定是否发布该结果以及如何发布。

| 文件 | 职责 |
|---|---|
| [`src/chain.ts`](src/chain.ts) | 相邻计划构造与当前格式绕过 |
| [`src/catalog.ts`](src/catalog.ts) | 物理版本分派与标头分类 |
| [`src/json.ts`](src/json.ts) | 分离的无损 JSON 快照与通用坐标校验 |
| [`src/filename.ts`](src/filename.ts) | 持久化、导出与 fixture 共用的规范 `session[.vN].jsonl` 文件名 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [已发布 v0 到 v1 迁移边](../session-format-v0-to-v1/README.zh.md)——冻结的历史解码与恒等转换。
- [静态目录](../session-format-catalog/README.zh.md)——第一方编解码器与迁移装配。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md)——持久化分帧与代际发布。

-----

<a id="model-experience"></a>
## 模型体验

### Session 还原

#### 模型看到什么

没有直接内容。消费方通过 `deriveMessages()` 从经过校验的当前产物重建模型历史。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

没有直接影响。迁移若改变当前历史，可能改变由请求重建逻辑拥有的缓存身份。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **最终当前历史仍常驻内存**——流式处理只保留有界中间状态，但返回的当前事件数组和必需的序号重映射表仍为 O(事件数)。
- **仅支持相邻整数版本**——本库不暴露 span、稳定事件身份或通用引用重写代数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
