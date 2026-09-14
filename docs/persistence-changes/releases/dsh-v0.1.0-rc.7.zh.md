---
description: "回溯 dsh-v0.1.0-rc.7 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.0-rc.7

[English](dsh-v0.1.0-rc.7.md) | 中文

## 概述

assistant/chunk 的 replayState 从 unknown 改为包含必需字段 response 和可选字段 blocks 的对象。写入格式仍为 0。

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
| 源码 tag | `dsh-v0.1.0-rc.7` |
| 源码日期 | 2026-08-17T11:03:17.000Z |
| 发行记录 | 有 release 对象。 |
| 前一版本 | [dsh-v0.1.0-rc.6](dsh-v0.1.0-rc.6.zh.md) |
| Session 写入版本 | 0 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->47 个根类型 / 376 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.0-rc.7.schema.json](dsh-v0.1.0-rc.7.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.0-rc.7
previous: dsh-v0.1.0-rc.6
sessionFormatVersion: 0
changes:
  - root: event:assistant/chunk
    before: 7fd942b2189b8dbf6e1a2c7b026e9ddd1e7dba3fbe5645708a76f4cddabb281d
    after: de04e4ae000cc4422a15fb86dce7c398c8a9970ac963b6f7f785e2276a939e62
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

检测到 1 个根类型变化、1 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `event:assistant/chunk.data.chunk.replayState` | `type-changed` | `version-bump` |

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
