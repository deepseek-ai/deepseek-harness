---
description: "浏览全部已捕获 DSH alpha/RC tag 之间的 Session 持久化类型变化，并离线校验历史快照。"
---

# DSH 预发行版本的持久化变化

[English](README.md) | 中文

## 概述

本归档提供 26 个 DSH alpha/RC tag 及其 25 次相邻转换的近似历史视图。每个版本包含简要说明、源码 tag、before/after 摘要以及变化类型的完整快照，供阅读和格式校验使用。它不确认历史运行时兼容性，也不替代[当前源码的确认记录](../README.zh.md)。

## 目录

- [已归档版本](#releases)
- [文件与范围](#files)
- [提取与限制](#extraction)
- [校验](#verification)
- [开发备注](#dev-note)

-----

<a id="releases"></a>
## 已归档版本

[清单](manifest.json)记录了 2026-09-12 捕获的全部 DSH alpha/RC tag：16 个有发行记录，最早的 10 个只有 tag。版本按语义版本顺序排列；不存在的 tag 不补造。首条记录是历史起点，变化数包含其所有根。

<!-- persistence-release-index:start -->

| Tag | 源码日期（UTC） | Session 版本 | 根 / 类型 | 变化根 |
|---|---|---|---|---|
| [dsh-v0.0.1-rc.1](dsh-v0.0.1-rc.1.zh.md) | 2026-08-10 | 0 | 42 / 341 | 42 |
| [dsh-v0.0.1-rc.2](dsh-v0.0.1-rc.2.zh.md) | 2026-08-11 | 0 | 47 / 374 | 45 |
| [dsh-v0.0.1-rc.3](dsh-v0.0.1-rc.3.zh.md) | 2026-08-12 | 0 | 47 / 374 | 12 |
| [dsh-v0.0.1-rc.4](dsh-v0.0.1-rc.4.zh.md) | 2026-08-12 | 0 | 47 / 374 | 0 |
| [dsh-v0.0.1-rc.5](dsh-v0.0.1-rc.5.zh.md) | 2026-08-12 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.1](dsh-v0.1.0-rc.1.zh.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.2](dsh-v0.1.0-rc.2.zh.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.3](dsh-v0.1.0-rc.3.zh.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.5](dsh-v0.1.0-rc.5.zh.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.6](dsh-v0.1.0-rc.6.zh.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.7](dsh-v0.1.0-rc.7.zh.md) | 2026-08-17 | 0 | 47 / 376 | 1 |
| [dsh-v0.1.0-rc.8](dsh-v0.1.0-rc.8.zh.md) | 2026-08-19 | 0 | 51 / 403 | 8 |
| [dsh-v0.1.1-rc.1](dsh-v0.1.1-rc.1.zh.md) | 2026-08-21 | 0 | 51 / 407 | 1 |
| [dsh-v0.1.1-rc.2](dsh-v0.1.1-rc.2.zh.md) | 2026-08-21 | 0 | 51 / 404 | 10 |
| [dsh-v0.1.2-alpha.1](dsh-v0.1.2-alpha.1.zh.md) | 2026-08-27 | 0 | 54 / 417 | 52 |
| [dsh-v0.1.2-alpha.2](dsh-v0.1.2-alpha.2.zh.md) | 2026-08-30 | 0 | 54 / 417 | 52 |
| [dsh-v0.1.2-alpha.3](dsh-v0.1.2-alpha.3.zh.md) | 2026-08-31 | 0 | 54 / 417 | 0 |
| [dsh-v0.1.2-alpha.4](dsh-v0.1.2-alpha.4.zh.md) | 2026-09-01 | 0 | 54 / 415 | 4 |
| [dsh-v0.1.2-alpha.5](dsh-v0.1.2-alpha.5.zh.md) | 2026-09-02 | 0 | 54 / 415 | 0 |
| [dsh-v0.1.2-rc.1](dsh-v0.1.2-rc.1.zh.md) | 2026-09-03 | 0 | 54 / 415 | 0 |
| [dsh-v0.1.3-alpha.1](dsh-v0.1.3-alpha.1.zh.md) | 2026-09-04 | 2 | 54 / 425 | 17 |
| [dsh-v0.1.3-alpha.2](dsh-v0.1.3-alpha.2.zh.md) | 2026-09-07 | 2 | 56 / 435 | 2 |
| [dsh-v0.1.5-alpha.1](dsh-v0.1.5-alpha.1.zh.md) | 2026-09-08 | 3 | 57 / 443 | 12 |
| [dsh-v0.1.5-alpha.2](dsh-v0.1.5-alpha.2.zh.md) | 2026-09-09 | 3 | 59 / 462 | 4 |
| [dsh-v0.1.5-rc.1](dsh-v0.1.5-rc.1.zh.md) | 2026-09-10 | 3 | 59 / 462 | 0 |
| [dsh-v0.1.5-rc.2](dsh-v0.1.5-rc.2.zh.md) | 2026-09-10 | 3 | 59 / 462 | 0 |

<!-- persistence-release-index:end -->

<a id="files"></a>
## 文件与范围

每个 tag 对应 `kind: persistence-release` 的中英记录、配对 sidecar 和 `.schema.json`。机器声明包含 tag、直接前驱、实际写入版本以及每个变化根的 before/after 摘要。首条快照包含全部根；后续快照只保存仍然存在的变化根及其所有可达类型。删除使用空 after，未变的版本保留空变化和空快照。

快照覆盖逻辑 Session header、物理 JSONL header、事件信封以及该 tag 的所有第一方事件及传递引用。类型数仅统计规范化后仍可达的定义。历史源码引用仅保留文件路径，不包含行号。

这些回溯记录与上层目录的当前确认链分开校验。当前规则对旧变化的分类只是阅读提示：历史上的 version 0 确实出现过不升版本的结构变化。不得把回填记录作为当前 PR 省略确认或版本提升的依据。

<a id="extraction"></a>
## 提取与限制

重建使用各 tag 中的源码、TypeScript 6.0.3 和已合入的 [schema 提取器](../../../scripts/persistence-schema.ts)。唯一提取适配是省略早期具体事件记录交叉类型中冗余的 `object` 成员。原有 `any` / `unknown` 保持不透明；没有为缺失引用额外替换不透明类型。发行快照 JSON 保留历史标识符；术语检查仍适用于人工记录和当前 schema。

前 22 个 tag 的 surface 事件合法地带有可选 `surfaceOp`。历史解析保留此可选性；当前源码解析仍要求该字段必需。旧版 `SessionHeader.version: number` 也按原声明保留，实际写入版本常量另行记录。不能从宽泛的 `number` 声明推导它。

本批 tag 的写入版本为 0、2 和 3，没有写入版本 1 的 tag。

摘要对应规范化后的重建类型，不是原始源码文本或当时工具链的逐字重现。说明仅提供结构变化的粗略理解；未重放旧应用、验证完整编解码行为或证明迁移安全。摘要未变也不能证明行为未变。

<a id="verification"></a>
## 校验

全部 26 个快照已通过规范图、根摘要和可达类型摘要校验。发行归档检查只读取本树中的清单、记录和快照，不访问 Git、网络或旧版本 checkout；它校验清单覆盖、前驱、before/after、快照类型完整性和双语机器声明。

```sh
pnpm run verify-persistence-releases
pnpm run doc-sync
```

标记区间内的索引、清单单元格和结构变化事实由快照生成。默认校验会拒绝陈旧事实。运行 `pnpm run verify-persistence-releases --write` 可在全部机器数据校验通过后刷新这些区间和配对记录；人工概述、源码证据、机器声明和 schema 文件保持不变。

tag 的完整性以清单的捕获范围为准；离线检查不会自动发现后续新 tag。配对记录及 Markdown 链接由常规文档检查校验。[格式模板](../../../.agents/skills/dsh-doc/templates/persistence-release.md)规定单条记录的字段。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
