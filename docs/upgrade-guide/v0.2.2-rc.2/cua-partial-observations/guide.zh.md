---
kind: upgrade-guide
description: "macOS CUA 返回带标记的部分 AX 观察，并区分观察失败与输入快照过期。"
---
# macOS CUA 隔离不可用的 AX 分支

[English](guide.md) | 中文

## 变更

此前，macOS `getState` 在一个遍历元素失效时会以 `STALE_SNAPSHOT` 拒绝整次 AX 读取。现在返回可读节点，在 `tree` 中用 `[One child could not be read.]` 标记每个不可用分支，并设置 `hasUnreadableElements: true`。标记没有元素 ID，分支内容未知。`truncated` 仍独立表示遍历上限。未遇到不可读节点或子项列表条目时，macOS 省略 `hasUnreadableElements`；其他 provider 也可以省略此字段。

顶层根节点失效不再阻止读取健康窗口。应用级观察将这些根节点标记为不可读，焦点查询遇到失效根节点时，`focusedWindowId` 为 null。观察准备阶段的失效 AX 对象导致请求范围无法确定时，返回 `AX_OBSERVATION_UNAVAILABLE`。发现未解析的窗口或 sheet 时遇到这类对象，读取会失败，不发布空的完整快照。观察期间 AX 返回 `cannotComplete` 时，此前返回 `NATIVE_ERROR`，现在也返回 `AX_OBSERVATION_UNAVAILABLE`。两类失败均在消息中保留失败的 AX 操作和原生错误码。权限、应用或窗口身份、取消及其他错误仍会拒绝读取。输入操作使用过期或不匹配的快照时，仍返回 `STALE_SNAPSHOT`。

## 迁移

更新原始工具调用方，保留 `hasUnreadableElements` 并显示分支标记。只使用最新成功树返回的元素 ID。通过窗口截图查看不可用内容；不完整树不能证明某个控件不存在。

将 `AX_OBSERVATION_UNAVAILABLE` 与输入快照过期分开处理。刷新失败仍会使同一范围的旧快照失效。重新读状态或使用截图，不自动重复此前的输入。确认局部元素失效返回带标记的部分状态，而通信和权限失败仍返回错误。
