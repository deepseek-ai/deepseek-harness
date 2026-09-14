---
description: "回溯 dsh-v0.1.0-rc.8 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.0-rc.8

[English](dsh-v0.1.0-rc.8.md) | 中文

## 概述

新增四种 team/* 事件及用户消息来源变体 team-message；assistant/message 新增可选字段 interrupted。写入格式仍为 0。

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
| 源码 tag | `dsh-v0.1.0-rc.8` |
| 源码日期 | 2026-08-19T15:11:50.000Z |
| 发行记录 | 有 release 对象。 |
| 前一版本 | [dsh-v0.1.0-rc.7](dsh-v0.1.0-rc.7.zh.md) |
| Session 写入版本 | 0 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->51 个根类型 / 403 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.0-rc.8.schema.json](dsh-v0.1.0-rc.8.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.0-rc.8
previous: dsh-v0.1.0-rc.7
sessionFormatVersion: 0
changes:
  - root: event:agent/inbox/spliced
    before: dea3a1d5640e0306a486f92b725a01b57e69439277978ca09dc246fb40016b90
    after: 7a0b347ba6a465a7813490036bde98bdc658609c6de9545ba58be26c372c5030
  - root: event:assistant/message
    before: 390aeb83383643633a1935f09f84fe19d2aee8d4f500a8de70f88d388562cc50
    after: fb7d974e1945b4c8e72ee540daf64eb9e81984030ff52e1a97a4e1f71b9dd2f9
  - root: event:session/title-llm-request
    before: 796a77af2c1452392f0cc62b99fba2d404d1c9eb10a8a2510a808fba6053cf24
    after: ee6c879669bb83325e4cd3011227f238bf51765744990fc4bb12089d6dd6563a
  - root: event:team/member
    before: null
    after: 31d13edbb5fe2f8b7a38056320a8a06275ee4426e0abf12d4741818beda5a9c9
  - root: event:team/message/delivered
    before: null
    after: c53bff743470c8bf11be698ced047072744ef088cce663a774b456d7a8982516
  - root: event:team/message/queued
    before: null
    after: 577054184d5f038bd96d6db70b76983a2bb62a8eea8eeed8ca3b0d47af0f462a
  - root: event:team/task
    before: null
    after: 1688a2451eef9da19eaf45f12c8a27df07b1a6e56fa57ba603118f5201bb435b
  - root: event:user/message
    before: 18c8d77777545808f232cd8d7730ce270cb1b737edd3eaa45e0da9436fd37a13
    after: e7eec68e39f9f44b2e53d799e5d5dd08f559558a27e93eb2a272782f040be50a
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

检测到 8 个根类型变化、8 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `event:agent/inbox/spliced.data.inserted[].source` | `union-variants-changed` | `version-bump` |
| `event:assistant/message.data.interrupted` | `optional-property-added` | `same-version` |
| `event:session/title-llm-request.data.messages[].source` | `union-variants-changed` | `version-bump` |
| `event:team/member` | `root-added` | `same-version` |
| `event:team/message/delivered` | `root-added` | `same-version` |
| `event:team/message/queued` | `root-added` | `same-version` |
| `event:team/task` | `root-added` | `same-version` |
| `event:user/message.data.source` | `union-variants-changed` | `version-bump` |

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
