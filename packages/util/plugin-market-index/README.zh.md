---
description: "供 DSH 读取器和索引生成器使用的插件市场索引格式 1 校验与安装参数。"
kind: "package-library"
---

# dsh-plugin-market-index

[English](README.md) | 中文

## 概述

插件市场索引格式 1 的校验器，没有运行时依赖。插件市场索引是一份 JSON 文件，列出可安装的 DSH 组合包（bundle）及其展示元数据。[格式 Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md) 定义该文档；本包是其可执行的规则集。DSH 的 [`dsh-plugin-market`](../../boot/plugin-market/README.zh.md) 用它读取索引，索引生成器在发布前用它校验输出。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是库，不是服务或插件：没有 `ctx`、没有注册、没有状态，也没有 I/O。

先把获取到的文档解析为 JSON，再把该值和读取它的 URL 传给 `parseMarketIndex`。遇到第一条被违反的规则时，它抛出 `MarketIndexError`，并附带违规值的 JSON 路径。成功的结果会丢弃格式未定义的成员，用空值填充缺失的 `metadata` 分组、`keywords`、`labels`、`sortKeys` 和 `engines`，按 SemVer 优先级降序排列每个插件的 `versions`，并把每个相对 `icon` 引用替换为其绝对 URL。

使用 `marketInstallTarget(name, version)` 安装一个版本：它返回精确的 pnpm spec（npm 为 `name@version`，Git 为固定到提交、可带 `path:` 参数的 `git+https` URL），该版本指定了 registry 时还返回首先询问的 registry。

-----

<a id="api"></a>
## API

```ts
import { MarketIndexError, marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
```

| 导出 | 作用 |
|---|---|
| `parseMarketIndex(value, indexUrl)` | 经过校验的 `MarketIndex`；遇到第一条被违反的规则时抛出 `MarketIndexError`。 |
| `marketInstallTarget(name, version)` | 安装该精确版本的 `{ spec, registry? }`。 |
| `MarketIndexError` | 携带 `path` 和 `reason` 的校验失败。 |
| `MAX_INLINE_ICON_BYTES` | 内联 `data:` 图标解码后载荷的最大字节数，即 32 KiB。 |
| `MarketIndex`, `MarketPlugin`, `MarketVersion`, `MarketEngines`, `MarketSource`, `MarketRepository`, `MarketIndexMetadata`, `MarketPluginMetadata`, `MarketDeclaration`, `MarketSortKeyDeclaration`, `MarketInstallTarget` | 经过校验的记录类型。 |

<a id="model-experience"></a>
## 模型体验

间接存在：通过 `dsh-plugin-market`，其 `plugin_market` 工具把经过校验的插件返回给模型。

#### KV Cache 影响

本包自身没有。携带插件的工具结果决定其请求的缓存行为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不检查生成器义务**——校验器无法验证 `name`、`version`、`publishTimestamp`、`engines.dsh` 或展示字段是否与其描述的包一致，也无法验证该包是否声明了组合包。
- **没有大小上限**——调用方在解析前限制文档大小。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
