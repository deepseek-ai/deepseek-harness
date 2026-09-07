# Agent Note: 会话快照 envelope 投影

Status: implemented
Archived: 2026-09-04

[English](2026-08-18-session-snapshot-envelope-projection.md) | 中文

## 问题

签入仓库的会话快照曾复制每一条正文记录的持久化 envelope。普通行的单调 `seq` 与墙钟 `time`，以及打包行的 `seq0` 与 `time0`，会让一次局部事件插入重新编号或计时后面的大段内容，即使其 payload 完全没有变化。这些字段是运行时持久日志所必需的，但在快照中反复出现会让评审 diff 主要描述存储机制，而不是行为变化。

## 决策

签入仓库的会话快照是持久化 JSONL 的投影。envelope 投影不会修改第一条 `session` header，包括 `version` 与 `createdAt`；其他 fixture 规范化仍可能替换 `createdAt`、`id` 和 `cwd` 等易变 header 值。每条正文记录保留判别字段、payload 和其他顶层字段；投影仅在相应字段存在时省略 `seq`、`time`、`seq0` 与 `time0`。嵌套在 payload 中的同名字段保持不变。

快照序列化会在写入每行前从已解析的正文对象上省略这些键。快照比较会组合常规值规范化与该投影；通用日志和 stream 规范化仍保留序号 envelope。运行时持久化不变。

回放的现有 `parseSessionLog` 入口接受投影后的 fixture，并在解码时为缺失的序号字段赋值。synthetic 事件时间从零开始；打包行的 `data.dt` 保留 fixture 中已有的相对间隔。投影实现仅位于各快照写入方内部，回放补值实现仅位于回放 parser 内部。仓库 fixture 布局检查使用该 parser，并继续保留规范打包行。

## 曾考虑的替代方案

**让运行时持久化省略这些字段。** 拒绝，因为持久会话校验、排序和事件关系依赖完整的序号／时间 envelope。不稳定性属于供评审的测试表示，而不是运行时格式。

**保留字段并将其归一化为零或位置序号。** 拒绝，因为每条正文记录仍会携带非行为噪声，位置值在插入事件后仍会大面积变化。

**把 payload 中的数字引用替换成语义化快照标识。** 本次变更拒绝，因为这会修改事件 payload，并要求按事件类型编写投影规则。payload 引用严格保留录制值；普通、连续的运行时序号足以让回放重建被省略的 envelope。

**新增第二份 replay 文件。** 拒绝，因为投影后的会话快照仍保留派生模型流和比较重新持久化行为所需的全部 payload。第二份 fixture 会重复 transcript，并引入同步成本。

**发布共享 session-snapshot codec 包。** 拒绝，因为本次变更不需要新的产品或支持层 capability。写入方只需在序列化时删除四个顶层字段，回放只需让现有 session-log parser 接受投影表示。新包和 record-level API 会扩大变更并建立长期归属承诺，却不会删除有意义的实现。

## 后果

新增、删除或移动事件时，不再重写后续每一条快照记录的 envelope。快照 diff 仍会展示 header 变化和全部 payload 变化，包括 `data` 内的数字序号引用。

签入仓库的文件不再是逐字节有效的持久化 JSONL。回放消费方必须使用 `parseSessionLog`，而不能把正文行直接交给 storage decoder；快照写入方仅在自身文件边界应用投影。synthetic 时间锚点不是历史墙钟数据；只有保留的打包间隔表示相对时间。仓库迁移与回写路径强制执行该投影，因此后续录制不会重新引入被省略的字段。
