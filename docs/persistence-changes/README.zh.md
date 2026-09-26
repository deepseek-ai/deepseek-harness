---
description: "审阅和维护已记录的会话持久化类型变更、对应 schema 快照以及兼容性决策。"
---

# 持久化类型变更记录

[English](README.md) | 中文

## 概述

本参考文档用于检查已确认的会话持久化类型变更及其前驱。每条记录把兼容性决策绑定到精确的生成 schema。本地检查仅使用当前检出目录中的文件，将当前源码与记录历史比较。修改持久化类型时，从[审阅实操手册](../cookbook/reviewing-persistence-type-changes.zh.md)开始。

较早的 tag 参见[预发行版本归档](releases/README.zh.md)。它重建 alpha/RC 类型差异，供历史阅读和格式校验使用；这些观察记录不作为当前兼容性确认。

按 Session 格式查看完整 schema 时，使用[格式参考](historical-formats/README.zh.md)。其覆盖范围由写入器常量决定，包括没有发布 tag 的中间格式。

## 目录

- [文件与职责](#files-and-ownership)
- [兼容性规则](#compatibility-rules)
- [历史与限制](#history-and-limitations)
- [开发备注](#dev-note)

-----

<a id="files-and-ownership"></a>
## 文件与职责

生成的[目录](../persistence-catalog.zh.md)提供可读声明和摘要；[schema 清单](../persistence-schema.json)包含规范化类型。根覆盖逻辑会话头、物理 JSONL 头行、事件封装以及每个仓库内声明的事件。被引用类型的变更会传递到每个受影响根的摘要。

每条带日期的记录有四个同目录文件：

| 文件 | 职责 |
|---|---|
| `YYYY-MM-DD-slug.md` | 英文确认文档，包含 `kind: persistence-change`、一份机器声明、兼容性说明和验证证据 |
| `YYYY-MM-DD-slug.zh.md` | 中文对侧文件，包含相同的机器声明 |
| `YYYY-MM-DD-slug.i18n.yaml` | 生成的双语一致性记录 |
| `YYYY-MM-DD-slug.schema.json` | 生成的完整变更后 schema，覆盖受影响且仍然存在的根 |

`finalized/vN.json` 记录已接受兼容性基线的完整根分类／摘要，以及对应已接受记录的语义哈希。[定稿记录](../session-format-status.zh.md#finalization-record)要求检查点存在。当前 V4 schema 可以兼容演进；即使写入器已推进，检查点仍保护已接受的机器声明和变更后 schema，而记录哈希不包含说明文字、别名和源码位置。

维护者通过 [`createPersistenceFinalizationCheckpoint`](../../scripts/persistence-finalization.ts) 捕获已确认格式，写入按版本命名的新检查点而不替换旧文件，并推进双语 `latestFinalizedVersion`。该函数要求当前 schema 与完整确认历史一致。提交前运行常规验证器。

[记录模板](../../.agents/skills/dsh-doc/templates/persistence-change.md)定义人工编写的格式。创建记录时可以提供双语说明输入，由命令生成机器声明、快照、目录对和一致性记录。验证器从英文文件读取一次机器声明，并检查中文声明是否相同。声明列出每个受影响的根、其前驱记录、变更后摘要和兼容性决策。新根没有前驱；删除操作没有变更后 schema，并保留显式删除标记。

<a id="compatibility-rules"></a>
## 兼容性规则

每个检测到的结构变更都需要确认。创建和更新记录依据这些固定规则推断最低决策；显式 `--decision` 是受检查的断言。规则应用于整个变更，因此允许的变更不能掩盖同时发生的破坏性变更。

| 检测到的变更 | 最低决策要求 |
|---|---|
| 添加可选事件体属性，包括其完整子树 | `same-version` |
| 将必选事件体属性改为可选 | `same-version` |
| 添加普通事件类型 | `same-version` |
| 为普通事件增加更高的数字 `data.version`，并原样保留所有旧载荷分支 | `same-version` |
| 在前后 schema 均带有相同受支持策略的 user/developer 消息源字段中，添加显式声明为归属信息的 kind | `same-version` |
| 将可选属性改为必选、添加必选属性、更改已有类型，或删除／重命名属性或事件 | `version-bump` |
| 更改会话头或事件封装 | `version-bump` |

定稿检查点保护已接受基线，不替换这些兼容性规则。在 V4 中，可选新增、普通事件及符合条件的归属 kind 新增可以使用新的同版本记录。破坏性差异要求更高的写入器版本，以及包含自身头版本递增的确认记录。不能更新已接受 V4 记录以复用其原有 3→4 转换。

普通事件可增加具有必选、非负整数 `data.version` 的载荷分支，新版本必须高于所有已有载荷版本，且所有已有分支结构保持不变。读取器必须保留旧载荷支持；在已有版本中增加分支、移除旧版本，以及修改 Session header 或事件封装仍属于破坏性变更。旧读取器可能拒绝新载荷版本。[Catalog 确认记录](2026-09-20-unknown-child-catalog.zh.md) 记录了此类演进。

提取器接受核心拥有的 source 属性上针对 user 或 developer 字面量角色的显式 `@persistenceSource` 绑定，不会从未标记类型中推断绑定。生产者用 `@persistenceAttribution` 标记其 `MessageSourceMap` 成员。该标记承诺：读取器无需生产者即可保留未知 kind 及其 JSON 元数据，且该 kind 不引入校验、回放或权限要求。生产者可以检查自身 kind 来恢复去重状态；其他读取器必须无需该投影也能保留并派生已记录的消息。记录的 schema 保存绑定、策略版本、字面量 `kind` 判别字段、保留承诺及符合条件的 kind 集合。Inventory format 2 保存这些承诺；没有绑定策略的提取仍使用 format 1。Session 格式版本独立于此。比较双方的快照必须带有兼容的策略状态。已有 kind 分组仍进行常规结构比较；删除、未标记的添加、策略更改及无关破坏性变更继续采用严格规则。同一 wire kind 的多个上下文形式分支归为一组。

同版本说明须解释旧记录如何保持可读，以及旧读取器如何处理新记录。可选新增须说明旧读取器为何可以忽略它而不改变回放；新增载荷版本须记录旧读取器的拒绝行为。对于必选改可选的变更，说明须解释读取器如何处理缺失值。检查器验证类型分类；审阅者判断说明是否成立。升版本记录在同一转换中包含递增的头部版本，并遵循[会话格式流程](../cookbook/adding-a-session-format-version.zh.md)。

当读取器按属性名拒绝 JSON 字段时，将该属性声明为可选 `never`，并添加无参数的 `@persistenceReserved` 标记。提取器保留这一禁止字段，因此后续允许 JSON 值属于已有字段类型变更。必选属性或允许 JSON 值的属性不能携带该标记。未标记的可选 `never` 和 `undefined` 属性保留现有省略行为。

<a id="history-and-limitations"></a>
## 历史与限制

一条基线记录完整的初始清单。后续记录使用前驱的变更后 schema 作为变更前 schema。验证器拒绝缺失前驱、环、同一根的重复后继、摘要不匹配，以及当前根与最新记录不一致的情况。独立的根可以独立演进。同一前驱上的两个变更在集成后需要形成一条有序历史。

已接受记录描述历史转换；添加后继时须保留其机器声明和 schema 快照。尚未接受的末端记录可以显式刷新；命令在生成产物前拒绝基线、被依赖的记录和被检查点锁定的记录。验证检查所保留检查点的哈希，但不证明检查点及其真源记录从未被一起修改。基线不依赖 Git 引用、远端服务或已发布版本的检出目录。

摘要描述声明的持久化类型，不描述运行时验证或行为。普通注释、源码位置、别名名称和无语义变化的声明重排不影响摘要。兼容性标记是记录的策略数据，会影响摘要。不带标记的版本 1 快照保留原有规范化、指纹和严格分类；包含策略的图使用独立的指纹域。对象字段、联合类型分支、交叉类型操作数和索引签名可以在解析类型不变时重排；元组位置和数字枚举值仍然影响摘要。目录文本和源码位置仍可能变化，因此应重新生成陈旧产物，无需为未变的摘要添加确认记录。`unknown` 等不透明类型不提供可比较的内部结构。纯行为变更以及不透明值中隐藏的结构不在本机制范围内。[决策记录](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.zh.md)说明这些取舍。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
