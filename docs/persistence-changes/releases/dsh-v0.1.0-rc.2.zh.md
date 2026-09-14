---
description: "回溯 dsh-v0.1.0-rc.2 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.0-rc.2

[English](dsh-v0.1.0-rc.2.md) | 中文

## 概述

重建的所有持久化根类型摘要均与上一个 alpha/rc 标签一致。写入格式仍为 0。

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
| 源码 tag | `dsh-v0.1.0-rc.2` |
| 源码日期 | 2026-08-13T09:23:52.000Z |
| 发行记录 | 只有 tag，没有 release 对象。 |
| 前一版本 | [dsh-v0.1.0-rc.1](dsh-v0.1.0-rc.1.zh.md) |
| Session 写入版本 | 0 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->47 个根类型 / 374 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.0-rc.2.schema.json](dsh-v0.1.0-rc.2.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.0-rc.2
previous: dsh-v0.1.0-rc.1
sessionFormatVersion: 0
changes: []
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

规范化后的根类型及其传递引用摘要与前一 tag 相同。

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
