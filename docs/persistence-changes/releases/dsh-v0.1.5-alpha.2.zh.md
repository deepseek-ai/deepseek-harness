---
description: "回溯 dsh-v0.1.5-alpha.2 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.5-alpha.2

[English](dsh-v0.1.5-alpha.2.md) | 中文

## 概述

新增 deliverables/presented 和 subagent/catalog。反馈记录新增可选字段 category，feedback/record 的 text 改为可选字段；写入格式仍为 3。

## 目录

- [发行来源](#evidence)
- [声明](#declaration)
- [结构变化](#changes)
- [校验](#verification)
- [开发备注](#dev-note)

-----

<a id="evidence"></a>
## 发行来源

这是供阅读和格式校验的近似回填，不是当时的兼容性确认。提取方法和覆盖限制见[归档说明](README.zh.md)。

| 项目 | 记录值 |
|---|---|
| 源码 tag | `dsh-v0.1.5-alpha.2` |
| 源码日期 | 2026-09-09T14:13:03.000Z |
| 发行记录 | 有 release 对象。 |
| 前一版本 | [dsh-v0.1.5-alpha.1](dsh-v0.1.5-alpha.1.zh.md) |
| Session 写入版本 | 3 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->59 个根类型 / 462 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.5-alpha.2.schema.json](dsh-v0.1.5-alpha.2.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 3`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.5-alpha.2
previous: dsh-v0.1.5-alpha.1
sessionFormatVersion: 3
changes:
  - root: event:deliverables/presented
    before: null
    after: 13d3d180f977bf78081d487ffa0ecb75857349bcab29a5a3fb48189fca2a6176
  - root: event:feedback/message-put
    before: 3b04fde0dc763cf84fbde7b6611b3194dd56d95d0c0bf0204311640468d586e1
    after: b5086d249e8502e9ead1d39156bb8d559bde7951cac0f14ce150345b4e42a2bf
  - root: event:feedback/record
    before: fb9df8180a202f3c845d5aa6a81697b2f7213f6735abc17535a55656be60a575
    after: b54940ff095c17e874c5be03815f4c2145a256cf3a1d34dae4ab2f7769dfffe8
  - root: event:subagent/catalog
    before: null
    after: ae1f7110feeec697b8cab42b68f7709aa7b3279764099dfb53c25890d2e5c871
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

检测到 4 个根类型变化、5 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `event:deliverables/presented` | `root-added` | `same-version` |
| `event:feedback/message-put.data.item.category` | `optional-property-added` | `same-version` |
| `event:feedback/record.data.text` | `property-made-optional` | `same-version` |
| `event:feedback/record.data.category` | `optional-property-added` | `same-version` |
| `event:subagent/catalog` | `root-added` | `same-version` |

<!-- persistence-release-changes:end -->

<a id="verification"></a>
## 校验

提取结果已通过规范图、根摘要和全部可达类型摘要校验；仅对历史 surface 事件允许源码原有的可选 `surfaceOp`。仓库内检查从前驱重建每个 tag，核对 before/after、快照覆盖和双语机器声明。

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## 开发备注

无。
