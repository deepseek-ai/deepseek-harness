---
description: "回溯 dsh-v0.1.1-rc.2 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.1-rc.2

[English](dsh-v0.1.1-rc.2.md) | 中文

## 概述

permission/preset 删除 origin；附件记录新增可选字段 originalDimensions，影响引用附件的消息及工具载荷。写入格式仍为 0。

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
| 源码 tag | `dsh-v0.1.1-rc.2` |
| 源码日期 | 2026-08-21T12:03:37.000Z |
| 发行记录 | 有 release 对象。 |
| 前一版本 | [dsh-v0.1.1-rc.1](dsh-v0.1.1-rc.1.zh.md) |
| Session 写入版本 | 0 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->51 个根类型 / 404 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.1-rc.2.schema.json](dsh-v0.1.1-rc.2.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.1-rc.2
previous: dsh-v0.1.1-rc.1
sessionFormatVersion: 0
changes:
  - root: event:agent/inbox/spliced
    before: 7a0b347ba6a465a7813490036bde98bdc658609c6de9545ba58be26c372c5030
    after: 402ee62cd1447d03340e206138fb107d865a3452ea73c15c22fb6bc48fdf181a
  - root: event:assistant/chunk
    before: de04e4ae000cc4422a15fb86dce7c398c8a9970ac963b6f7f785e2276a939e62
    after: 51045f351a56e61da8be1dd5bba8080ac5e8ac2ff3d62a308a7f3e710b7cb18b
  - root: event:assistant/message
    before: fb7d974e1945b4c8e72ee540daf64eb9e81984030ff52e1a97a4e1f71b9dd2f9
    after: 395d04e6fd6f40eae4099cfaf3793fb710cee646fac53378433bc2d74bebd386
  - root: event:compaction/summary
    before: 67c53a0cdc70f8330a84b9a16481bc6cc45e23d1ae8041485a0b0453c11fc9aa
    after: 80316c3b92f42f246ab57d649dc546a8adeb11b96db3b11361ea32709b6bdc35
  - root: event:permission/preset
    before: 7271e4b771406aaf06014c2269edd6cb68055bb8b8686571730813ce0ababc22
    after: 5c45bf4c544a7211dcd8ba6ba7e5f1bc39b49e7a9df9d5cbdc8e87c22771b37b
  - root: event:session/title-llm-request
    before: ee6c879669bb83325e4cd3011227f238bf51765744990fc4bb12089d6dd6563a
    after: 9d5c0dabeec05f0ba9edd8ca24754de13dc2d3af5c302ff44eda04fb1a602257
  - root: event:team/message/queued
    before: 577054184d5f038bd96d6db70b76983a2bb62a8eea8eeed8ca3b0d47af0f462a
    after: a6a26c92459c96e4f342e58d7e41c71956e7e62c9280e30e260df58409a3012c
  - root: event:tool/code-dispatch
    before: c39526f02abfb7a3b47a7e4f12da2125d4025bf588286e16a0d22baedbb1a83b
    after: c14c2fdd439461cfc85105c6f620b0f62f799e3a69fb48196e938ec045aa0390
  - root: event:tool/result
    before: 3b8a618295a9388a612e8de2e0997c6e59d0e82d034419317bf616a496ae593c
    after: a79feb023a08a8b73d254e29e78f13045b6773ce377b0c4156fcdf1368c146ab
  - root: event:user/message
    before: e7eec68e39f9f44b2e53d799e5d5dd08f559558a27e93eb2a272782f040be50a
    after: 70a39b3639ca6c2eeabf1e2c8ef4cbc23e24c947e72bf0c28754e7c2f713be26
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

检测到 10 个根类型变化、11 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `event:agent/inbox/spliced.data.inserted[].content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:assistant/chunk.data.chunk.block.attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:assistant/message.data.message.content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:compaction/summary.data.rawOutput[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:compaction/summary.data.summary[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:permission/preset.data.origin` | `property-removed` | `version-bump` |
| `event:session/title-llm-request.data.messages[].content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:team/message/queued.data.message.content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:tool/code-dispatch.data.content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:tool/result.data.message.content[0].content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |
| `event:user/message.data.content[].attachment.originalDimensions` | `optional-property-added` | `same-version` |

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
