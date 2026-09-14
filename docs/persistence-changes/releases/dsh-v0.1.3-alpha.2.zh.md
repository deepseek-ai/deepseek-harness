---
description: "回溯 dsh-v0.1.3-alpha.2 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.3-alpha.2

[English](dsh-v0.1.3-alpha.2.md) | 中文

## 概述

新增 feedback/message-put 和 feedback/message-delete，已有持久化根类型的摘要保持不变。写入格式仍为 2。

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
| 源码 tag | `dsh-v0.1.3-alpha.2` |
| 源码日期 | 2026-09-07T11:45:35.000Z |
| 发行记录 | 有 release 对象。 |
| 前一版本 | [dsh-v0.1.3-alpha.1](dsh-v0.1.3-alpha.1.zh.md) |
| Session 写入版本 | 2 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->56 个根类型 / 435 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.3-alpha.2.schema.json](dsh-v0.1.3-alpha.2.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 2`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.3-alpha.2
previous: dsh-v0.1.3-alpha.1
sessionFormatVersion: 2
changes:
  - root: event:feedback/message-delete
    before: null
    after: 3ee93b06f3a125850337602bcdf155d2538c43a5c944ec55b1b3c365152d6796
  - root: event:feedback/message-put
    before: null
    after: 3b04fde0dc763cf84fbde7b6611b3194dd56d95d0c0bf0204311640468d586e1
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

检测到 2 个根类型变化、2 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `event:feedback/message-delete` | `root-added` | `same-version` |
| `event:feedback/message-put` | `root-added` | `same-version` |

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
