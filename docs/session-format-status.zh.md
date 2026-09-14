# Session 格式版本与发布状态

[English](session-format-status.md) | 中文

## 概述

本参考区分工作区的 Session 写入器版本与最新已发布的 Session 格式。代码常量拥有写入器版本；下方发布记录拥有最新已发布格式及其发布证据。其他文档链接到这里，而不重复声明哪个版本是当前、下一个或尚未发布的版本。

## 目录

- [单一真源](#sources-of-truth)
- [发布记录](#release-record)
- [更新记录](#updating-the-record)
- [开发备注](#dev-note)

<a id="sources-of-truth"></a>
## 单一真源

- **工作区写入器：**[核心 Session 类型](../packages/core/session/src/types.ts)中的 `SESSION_FORMAT_VERSION` 是代码中唯一手工维护的当前写入器版本号。[目录生成器](../scripts/gen-session-format-catalog.ts)推导 codec 顺序，并检查相邻迁移是否到达该版本。包版本、codec 导出名称、fixture（测试前置数据）文件名或投影缓存版本都不是写入器版本的权威来源。
- **最新已发布格式：**下方记录中的 `latestReleasedVersion` 标识已发布的 Session 格式。`evidenceTag` 指定一个已发布的产品版本，其标签对应的写入器具有该值；它不必是首次携带该格式的发布。双语副本按同一记录校验，不作为独立决策维护。
- **发布状态：**比较写入器常量与已核实的发布记录。相等表示写入器格式已经发布。写入器版本更高表示它是超出记录中发布版本的开发目标。用较新分支中已核实的记录对比旧工作区时，较低的写入器版本表示较旧的写入器格式；本地一致性门禁会拒绝同一工作区内的这种大小关系。不另行维护 released 布尔值。在声明更高版本尚未发布前，必须核实是否已有产品发布推进了记录。

产品的 alpha、beta 或 release-candidate 发布都会确立已发布 Session 格式的义务。GitHub 的 prerelease 标记不会让持久化用户数据成为可丢弃数据。缺少发布记录不代表尚未发布。[版本与真源决策](../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)拥有兼容性决策；[已发布格式迁移](../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)拥有不可变代际与相邻转换规则。

[格式参考](persistence-changes/historical-formats/README.zh.md)记录从零到工作区写入器的每个整数版本，提供历史 schema 并引用现有的当前目录。

<a id="release-record"></a>
## 发布记录

```yaml session-format-release
latestReleasedVersion: 3
evidenceTag: dsh-v0.1.5-alpha.1
```

证据：已发布产品标签 `dsh-v0.1.5-alpha.1`；该标签的写入器路径：`packages/core/session/src/types.ts`。

<a id="updating-the-record"></a>
## 更新记录

实现结构性写入器变更时，一起更新代码常量与相邻迁移目录；不要在产品发布前推进此发布记录。当产品首次发布更高的 Session 格式时，确认发布事实及对应标签的写入器，然后在同一次双语更新中推进本记录与证据标签及该标签的写入器路径。后续携带相同格式的产品发布无需改变此记录。开发主干上的记录绝不降低。

[文档标准测试](../scripts/doc-standard.spec.ts)检查记录结构、双语一致性、证据标签及写入器路径一致性，以及文档中的已发布版本不高于工作区写入器。这个无密钥检查不会查询 GitHub，也不能证明记录是最新的；核实发布事实仍属于发布更新的一部分。

一般行为使用“当前格式”和“下一条相邻版本”等表述。固定迁移的输入与输出、协议 schema、历史证据及针对特定版本的测试保留明确版本号。[格式版本实操手册](cookbook/adding-a-session-format-version.zh.md)用 N 表示已核实的最新发布格式，用 N+1 表示其后继版本。

<a id="dev-note"></a>
## 开发备注

无。
