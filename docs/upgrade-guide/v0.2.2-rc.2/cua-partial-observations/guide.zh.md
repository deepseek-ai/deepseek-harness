---
kind: upgrade-guide
description: "macOS CUA 返回带标记的部分 AX 观察，并区分观察失败与输入快照过期。"
---
# macOS CUA 隔离不可用的 AX 分支

[English](guide.md) | 中文

## 变更

此前，macOS `getState` 在一个遍历元素失效时会以 `STALE_SNAPSHOT` 拒绝整次 AX 读取。现在返回可读节点，在 `tree` 中标记每个不可用分支，并设置 `incomplete: true`。标记没有元素 ID，分支内容未知。`truncated` 仍独立表示遍历上限。完整的原生观察成功结果包含 `incomplete: false`；共享 provider 参数定义允许其他 provider 省略此字段。

观察准备阶段遇到失效 AX 元素时，现在返回 `AX_OBSERVATION_UNAVAILABLE`。请求的窗口或 sheet 因发现阶段失败而无法解析时，读取会失败，不发布空的完整快照。观察期间 AX 返回 `cannotComplete` 时，返回 `AX_COMMUNICATION_FAILED`。权限、应用或窗口身份、取消及其他错误仍会拒绝读取。输入操作使用过期或不匹配的快照时，仍返回 `STALE_SNAPSHOT`。

## 迁移

更新原始工具调用方，保留 `incomplete` 并显示分支标记。只使用最新成功树返回的元素 ID。通过窗口截图查看不可用内容；不完整树不能证明某个控件不存在。

将两种观察错误码与输入快照过期分开处理。刷新失败仍会使同一范围的旧快照失效。重新读状态或使用截图，不自动重复此前的输入。确认局部元素失效返回带标记的部分状态，而通信和权限失败仍返回错误。
