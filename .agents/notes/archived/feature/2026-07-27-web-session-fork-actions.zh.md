# Agent Note: Web session fork 操作

Status: implemented
Archived: 2026-09-04

[English](2026-07-27-web-session-fork-actions.md) | 中文

## Problem

Session store 已提供按完成轮前缀创建子会话的 fork 原语，但 Web 端没有一份统一的交互约定。Session 行菜单只能表达「从最新完成轮分支」，消息 IconActions 还需要表达「从这条消息所在轮分支」；如果两处各自解释边界、切换与失败行为，同一个用户动作会形成两套语义。把 fork 子会话嵌套在源会话下还会让新选中的子会话依赖祖先展开态才能看见，并削弱 workspace 的手动排序模型。

## Decision

本决策中的消息资格部分由[已完成轮次尾部决策](../bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md)收紧；共享运行时操作、注入归属、标题处理和同级列表决策仍然有效。

Web 的 session 行菜单与消息 IconActions 共用 client runtime 的 `sessions.fork` 操作。Session 行传 `{ sessionId, increaseTitle: true }`，因此在源会话最后一个已完成轮次处分支；符合条件且位于已完成轮次尾部的消息传 `{ sessionId, atSeq: node.seq, increaseTitle: true }`，因此在以该消息结束的轮次处分支。`increaseTitle` 只由 client 消费：子会话进入本地列表后，client 把源会话持久化标题尾部的 `(N)` 或 `（N）` 递增并保留括号样式，无编号时追加 ` (1)`，没有持久化标题时不改名；Host fork 请求仍只有 `sessionId` 与可选的 `atSeq`。改名成功后调用方才打开子会话；fork 或改名失败时保持源会话与当前选择不变，改名失败时已创建的子会话仍留在列表中。

`forkAt(seq)` 只在 ui-conversation 的 apply 注入层接触 session 服务，消息组件只回传事件 `seq`。Session 行同理只通过 ui-workspace 的注入回调发起操作；两个呈现包都不持有 session mutation 状态，也不复制 host 的边界求值。

Session lineage 不投影成列表层级。WorkSpace 模式按 `WorkspaceView.sessionIds` 的手动序把源会话与所有 fork 子会话显示为同级行，每行都可独立打开、搜索和拖拽；In one list 模式继续按 `updatedAt` 严格排序；Ungrouped 组在没有 workspace 账本时也按 recency 排序。`parentId` 仍用于 lineage 和后续查询，但不控制 session 列表可见性。

## Alternatives considered

**只接 session 行菜单。** 否决：用户在消息处已经选择了更精确的上下文，强迫其回到列表只能退化为最新完成轮，且已展示的消息分支图标会成为无响应控件。

**只允许用户消息分支。** 否决：已定稿 assistant 内容同样有稳定事件 `seq`，host 会把它归入所属完成轮；让两个外观相同的分支按钮只有一个可用会制造不可见的行为差异。

**按 `parentId` 把 fork 子会话嵌套在源会话下。** 否决：lineage 不是导航所有权；嵌套要求自动展开祖先才能看见当前项，并让子会话无法参与 workspace 的同级手动排序。

**由消息组件直接调用 session 服务。** 否决：client 组件不得接触 `ctx` 或业务服务；注入回调让 mutation 留在 apply 世界，组件保持纯 props。

## Consequences

用户可从 session 行或符合条件的已完成轮次尾部消息创建分支，两处最终走同一个 runtime/host 操作；消息点位保留精确事件边界，列表点位保留「最新完成轮」快捷语义。连续 fork 的标题按 `(1)`、`(2)` 递增，而不是重复追加 `(1)`；全角括号标题保持全角样式。所有 fork 子会话立即作为普通同级行出现，列表不再需要 session 展开状态、递归节点或 twist 控件。

Fork 与子会话改名失败都保持静默并保留源选择，避免一个派生操作破坏当前阅读位置；该取舍也意味着 UI 暂不提供失败原因或重试入口。包级测试固定符合条件的消息 `seq` 转发、标题递增与同级列表派生，`apps/web/tests/message-actions.e2e.ts` 通过装配后的应用执行 assistant 消息分支与 session 行菜单分支。
