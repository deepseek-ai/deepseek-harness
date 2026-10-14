# Agent Note: 需要迁移时引导打开会话

Status: implemented

[English](2026-09-29-explicit-session-history-preparation.md) | 中文

## 问题

展开 subagent 目录或从侧栏 fork 可能触发旧会话的格式迁移。

## 决定

WorkspaceBrowser 行菜单的 fork 请求携带 `allowMigration: false`，由 Host 在调用原 fork 流程前检查 `stat` 的格式信息。只有源格式需要迁移时才拒绝，并显示带“打开原会话”操作的应用级 Toast。该操作只导航，不自动重发 fork。没有 live Session 或 Client 尚未打开历史不构成拒绝理由。

其他 fork 调用者省略该选项，允许自动迁移。

`session.projections` 同样先检查存储格式，当前格式冷历史继续通过原观察流程读取准确投影。成功时返回 `kind: sequenced` 和真实 `asOfSeq`；需要迁移时返回 `kind: migration-required` 的缓存提示。Client 保留这一读取状态，缓存值不能覆盖 history 或 control 已发布的有序值。

`stat` 返回的 `formatStatus` 携带迁移库已有的分类；`header` 仍是当前逻辑格式。它描述存储格式，不描述迁移任务进度或内存准备缓存。

在需要迁移且缺少 `subagentCatalog` 时，Web 将该会话行标为“需要迁移”，保留打开历史的操作，但不能展开下级，也不改变子会话的 mode。打开会话后，历史与 control 投影提供其目录。已有目录仍可使用，包括空目录。会话列表的谱系用于解析导航地址，不用于补齐缺失的目录成员。普通加载、取消和存储错误不转换成这一迁移分支。

create/adopt、全文搜索和普通历史打开允许自动迁移。

本决策为[目录投影查询](../../archived/simplification/2026-09-08-web-subagent-catalog-projections.md)增加迁移例外。[会话观察](2026-08-25-session-observations-and-projection-owned-client-state.zh.md)的准确读取和租约，以及[投影缓存读取](2026-09-19-projection-cache-listing-identity-and-cached-rows.zh.md)的身份校验与缓存／有序分层继续适用。

## 考虑过的替代方案

**把所有冷会话都视作需要迁移。** 是否驻留与存储格式不同；这样会拒绝可以正常完成的 fork，并丢失能够从磁盘读取的目录信息。

**Host 全局禁止自动迁移的 fork。** 侧栏的交互选择不适用于其他调用者，因此限制由该请求显式携带。

**侧栏 fork 自动打开并重试。** 打开会话由用户明确选择，fork 不在迁移后自动执行。

**按会话列表中的父 id 派生目录。** 这需要第二套成员派生逻辑；显式打开会话即可获取目录。

**让缓存提示携带 `asOfSeq: -1`。** 提示没有当前历史的事件切点，不能参与序号比较。

## 影响

需要迁移的会话通过现有打开流程完成准备；无需迁移的会话仍可冷读和 fork。目录的缓存提示可能落后于日志，后续准确投影替换它们。

后续单会话迁移进度由独立的 follow 重定向提案讨论，本决策不实现该流程。
