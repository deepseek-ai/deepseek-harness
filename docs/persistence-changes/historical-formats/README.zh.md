---
description: "查找从 V0 到工作区写入器版本的每个 Session 格式的完整持久化类型声明。"
---

# Session 持久化格式

[English](README.md) | 中文

## 概述

本参考用于查阅已存储 Session 代际的 header、事件信封与载荷类型。低于工作区写入器版本的每个格式都有双语文档与完整 schema 快照。当前格式使用生成的持久化目录。[版本真源](../../session-format-status.zh.md)负责写入器常量与发布状态。

## 目录

- [格式参考](#formats)
- [范围与证据](#scope)
- [维护覆盖](#maintenance)
- [开发备注](#dev-note)

-----

<a id="formats"></a>
## 格式参考

索引由已验证的快照与当前写入器常量生成。每个历史参考标明其来源检查点；Session 格式编号不能标识该格式内的每次事件载荷修订。

<!-- persistence-format-index:start -->

| 格式 | 来源 | 参考文档 | 机器 schema | 根类型 / 类型 |
|---|---|---|---|---|
| 0 | `dsh-v0.1.2-rc.1` | [V0](v0.zh.md) | [JSON](v0.schema.json) | 54 / 415 |
| 1 | PR #3349 | [V1](v1.zh.md) | [JSON](v1.schema.json) | 54 / 415 |
| 2 | `dsh-v0.1.3-alpha.2` | [V2](v2.zh.md) | [JSON](v2.schema.json) | 56 / 435 |
| 3 | PR #4320 | [V3](v3.zh.md) | [JSON](v3.schema.json) | 60 / 467 |
| 4 | 当前工作树 | [当前目录](../../persistence-catalog.zh.md) | [JSON](../../persistence-schema.json) | 62 / 587 |

<!-- persistence-format-index:end -->

<a id="scope"></a>
## 范围与证据

每组 `vN.md` / `vN.zh.md` 文档包含 `kind: persistence-format`、将每个根类型键绑定到已记录摘要的相同 `yaml persistence-format` 声明、配对记录及完整的 `vN.schema.json`。[模板](../../../.agents/skills/dsh-doc/templates/persistence-format.md)定义这些记录。根类型覆盖所选检查点的逻辑 Session header、物理 JSONL header、事件信封与所有第一方事件；每个根包含所有可达的声明类型。打包的物理 body 记录由每页链接的独立 codec 负责。

V0 与 V2 使用[已收录预发布归档](../releases/README.zh.md)中最后一个对应 tag。由于收录的 tag 没有 V1 写入器，V1 使用其参考文档中标识的中间源码树。V3 捕获 PR #4320 中 V4 写入器变更前已验证的目录。历史来源保留文件路径，不包含行号。快照保留历史可选字段与不透明值，不会将当前类型替换到旧格式中。历史标识符仅在 schema JSON 与已验证的生成 schema 区间中原样保留；人工说明遵循当前术语规则。

这些参考描述选定的 schema，不表示历史应用回放结果或迁移安全性。同版本内新增事件与可选载荷变更可以产生其他有效目录。预发布归档保留逐 tag 差异；[变更记录](../README.zh.md)保留当前兼容性确认。这些格式快照不替代任何一种历史。

<a id="maintenance"></a>
## 维护覆盖

`verify-persistence-formats` 从 `SESSION_FORMAT_VERSION` 推导所需的整数范围。每个更早的整数都需要独立的完整记录。当前目录与 schema 必须存在且匹配写入器版本。检查会拒绝缺失、多余、编号错误、不完整或不一致的记录及过期生成区间，无需获取 Git 历史或查询服务。

推进写入器之前，验证当前目录并归档原格式。对于 V3 到 V4 的变更，在写入器与当前 schema 仍描述 V3 时运行以下命令：

```sh
pnpm run verify-persistence-catalog
pnpm run verify-persistence-formats --archive 3
```

对于其他转换，将 `3` 替换为原写入器版本。`--archive N` 从当前目录创建 `vN.schema.json`，只保留从根类型可达的类型，并移除源码行号。它拒绝已存在的目标、与当前写入器不同的版本、无效或不完整的 schema，以及与 `--write` 的组合。使用[模板](../../../.agents/skills/dsh-doc/templates/persistence-format.md)添加该快照的双语记录与来源证据。保留所有更早的记录。后继格式使用当前目录；复制新的当前目录不能满足归档前驱的要求。运行时变更遵循[格式版本实操手册](../../cookbook/adding-a-session-format-version.zh.md)。

注释标记内的 schema 定义与索引由工具生成。推进写入器并完成机器数据与人工证据后，刷新其表格和配对记录，再执行验证：

```sh
pnpm run verify-persistence-formats --write
pnpm run verify-persistence-formats
pnpm run doc-sync
```

`--write` 先验证机器数据，再更新生成的 Markdown 与配对记录。它保留人工说明、机器声明和 schema。默认验证也会拒绝过期的配对记录；标准文档检查验证翻译与本地链接。当前目录的新鲜度仍由 `verify-persistence-catalog` 负责。

<a id="dev-note"></a>
## 开发备注

无。
