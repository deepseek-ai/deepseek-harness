---
description: "供持久化读取方使用的构建期静态第一方 Session 格式编解码器与相邻迁移装配。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-catalog

[English](README.md) | 中文

## 概述

`dsh-session-format-catalog` 为持久化提供一个确定性的 Session 格式读取器，且无需查询已挂载插件。它把冻结的 v0、v1 与 v2 编解码器和相邻的 v0 到 v1、v1 到 v2 迁移边装配起来，在模块初始化时校验完整且无缺口的迁移链，并通过 `sessionFormatCatalog` 暴露物理分派、仅标头分类、迁移和当前格式编码。

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

当持久化与测试支持读取方需要在任何功能插件挂载前取得完整第一方已发布格式清单时，导入本库。功能组合不会注册或重排其条目。它不发布运行时不变式伴生入口，因为构造过程会拒绝无效静态清单，每次读取也会校验完整结果；目录不保留可独立分叉的运行时可变关系。

### 入口

```text
const descriptor = sessionFormatCatalog.readHeader(physicalHeader)
const current = sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(physicalHeader, rows))
```

从包根导入 `sessionFormatCatalog`。JSONL 读取方把解析后的标头与行 JSON 值传给 `decodeArtifact()` 或 `decodeRecoverableArtifact()`，使用 `migrate()` 迁移逻辑结果，并且只使用 `encodeCurrent()` 序列化经过校验的当前产物。列表读取调用 `readHeader()`，绝不打开事件正文。标头读取会校验每个相邻目标，然后通过已安装的当前 Session 包还原最终标头。

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
