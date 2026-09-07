# Agent Note: 移除 steering（中途引导）插话标注

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-web-remove-steering-interjection-caption.md) | 中文

## 问题

[上下文来源与 steer 标识决策](../feature/2026-08-04-web-context-source-and-steer-marks.zh.md)给每个持久与待处理的 steering 气泡加上了 `插话` / `Interjection` 标注，让 transcript（文本记录）能说明哪条右对齐气泡打断了正在运行的轮次。这个标注重复了消息流已经呈现的事实：steering 气泡位于轮次中途、夹在被它打断的助手内容之间，而开轮提示位于轮次边界。在每个 steer 气泡上方常驻一行三级文字，并没有让一个能看到位置的读者多读出任何信息，而且它是所有用户样式气泡中唯一带装饰的，还破坏了原本统一的右对齐节奏。

## 决策

steering 完全按用户气泡渲染。`UserStyleBubble` 不再有 steering 标志，`message.steering` locale 键与 `.steeringMark` 样式已删除，`PendingSteeringBubble` 与 `UserMessageNodeView` 只传内容与操作。轮次中途的 steer 只能靠它在运行轮次消息流中的位置辨认，除此之外没有任何标识。

运行时的区分保持不变。从持久 `agent/inbox/spliced` 历史投影 `SteeringMessageNode`、`data-pending-steering` 属性、待处理到持久的交接全部保留：待处理生命周期无论呈现如何都需要节点身份，测试也仍通过该属性定位待处理气泡。

本决策部分取代[上下文来源与 steer 标识决策](../feature/2026-08-04-web-context-source-and-steer-marks.zh.md)中的 steering 条款；其上下文来源与召回命名仍然有效。这个标注此前已经翻转过一次：[已归档的取消 steer 装饰决策](../../archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md)在 composer 无法 steer 时移除了它，2026-08-04 的决策在 composer 获得 Steer 手势后把它加了回来。本次移除不重议手势本身——steering 入口、Queue dock 的插话发送操作、待处理生命周期各归其主——只判定 transcript 不需要为其结果命名。

## 考虑过的替代方案

**保留标注。** 它是现状，维持成本低，但它永久装饰每个 steer 气泡，只为编码气泡位置已经陈述的事实。不承载读者缺少的信息的装饰应当删除，而不是维护。

**连 `SteeringMessageNode` 区分一起删。** 节点类型派生自持久 inbox 历史，驱动待处理到持久的交接；它是回放事实，不是呈现。把它并入 `UserMessageNode` 会改变投影行为，却没有任何 UI 收益。

**换更安静的装饰（底色、缩进、悬停标签）。** 任何替代装饰都会用更弱的表达重新提出同一个问题。transcript 需要的区分是位置性的、已经可见的；换成更含蓄的装饰保留了成本，却丢掉了文字标注唯一的优点，就是明确。

## 测试

- `packages/client/ui-conversation` 的 jsdom 覆盖固定了纯气泡行为：待处理交接测试通过 `data-pending-steering` 定位待处理气泡，在没有任何标注的前提下断言单气泡交接；MessageItem 的 steering 分支在无标注气泡上断言可复制且无分支操作。
- 无密钥的组装 Web goldens（`steering/mid-steer`、`steering/settled`、`plan-review/approved`）用未变的会话 fixture 回放，不含标注文字。

## 后果

- 回放的 transcript 不再为 steering 命名：读者靠消息在轮次中的位置推断这是一次中途插话。对快速扫读轮次边界的读者，这个推断弱于显式标签；本决策接受这一代价。
- 待处理的 steer 气泡在被准入前与普通已发送气泡在视觉上完全一致，仅缺少时间戳。
- 重新引入任何形式的 steering 装饰都需要一个取代本 note 的新产品决策。
