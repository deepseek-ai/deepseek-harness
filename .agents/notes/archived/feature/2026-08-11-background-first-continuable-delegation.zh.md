# Agent Note: 可继续委派采用后台优先

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-background-first-continuable-delegation.md) | 中文

## 问题

可继续 child 已经具备持久化 id、独立轮次、后续消息以及由管理器负责的结算通知。如果把省略的 `run_in_background` 视为前台，模型就必须在每次调用时重复写出 `true`，才能得到这套生命周期。这样也会掩盖真正有用的调度判断：只有当 parent 的下一步动作需要 child 结果时，parent 才应等待。

child 的初始任务会告诉它如何使用共享的 `send_message` 工具向直接 parent 发送消息，而[由管理器负责的结算投递](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)会独立发送本次运行的结束结果与收尾消息。child 可以在结算前发送进度或最终交接。后台优先调度会保留两者：由 Agent 编写的消息仍是模型的显式选择，由管理器生成的通知则不依赖模型是否遵循指令，覆盖每种终止路径。

## 决策

`tool-subagent` 根据选定的生命周期策略解析省略的 `run_in_background`。`backgroundMode: continuable` 会把省略解析为后台并立即返回持久化 child id；显式传入 `false` 会选择前台并等待结果。`backgroundMode: one-shot` 保留前台默认行为，因为它的后台输出仍需通过 Task 收集。`enableRunInBackground: false` 仍会省略该参数、拒绝强制传入的 `true` 并在前台运行。系统不增加第二个默认选择配置。

面向模型的文本按位置划分职责：

- 工具描述说明调用行为、持久化 id、运行时结算通知、通过 `send_message` 继续对话，以及显式前台覆盖；
- `run_in_background` 参数说明具体生命周期的默认值以及何时覆盖；
- `tool:<toolName>` 系统提示词 section 会告诉模型同时启动相互独立的委派、在它们运行时继续有用工作，并且仅当下一步动作依赖结果时选择前台。只有当该工具在组装作用域中仍可见时才会渲染这个 section，因此子级工具限制会同时移除 schema 与对应指引。

child 会在继承的 fork 种子之后，从初始任务获得直接 parent id 与返回指引。它可以调用零次或多次 `send_message`，包括发送会改变 parent 下一步动作的发现，以及自包含的最终交接。由管理器负责的结算仍然无条件执行，不检查 Agent 消息是否已经到达。这两条消息可能重复最终内容，但作者和用途不同：`send_message` 携带 child 自己选择的内容，结算则记录本次运行如何结束，并在 child 无法配合时保留终止输出。两者都使用 Agent inbox 与固定 Steer 调度；已接受的 child 消息先于后续结算通知。

无密钥 headless `subagent-settlement` 场景省略 `run_in_background`，收到立即返回的 child id；尽管 fixture（测试前置数据）有意不发送 child 编写的消息，它仍通过管理器生成的结算通知到达 parent 最终答案。包测试另行固定了显式 `false` 的前台语义、parent 调度文本以及 child 的 parent-id 返回指引。

## 考虑过的替代方案

**把字段替换为 `run_in_foreground`。** 反转布尔值会让常见情形以肯定形式表达，却会为同一项调度选择创造第二套词汇，并迫使所有现有调用方与面向提供方的 transcript（文本记录）一起改变。保留 `run_in_background` 可以维持单一字段，并把前台作为显式例外。

**增加可配置的后台默认值。** 独立默认值可能与 `backgroundMode`、schema 措辞和已安装提示词不一致。生命周期策略已经区分可继续 Activation 与一次性 Task，而这个区别正好决定了后台完成是否会自动投递。

**只修改提示词。** 如果运行时解析不变，提示词偏好仍会让省略参数的调用进入前台。模型必须能够依赖公布的默认值，而不是在每次工具调用中完美复述它。

**最终 Agent 消息到达后抑制结算通知。** 条件结算会重新引入每次 Activation 的记账，并且当 child 先发送进度、随后失败时丢掉无条件运行时保证。即使生成的消息与最终交接重叠，结算仍然无条件执行。

**只用 `send_message` 发送结算前的进度。** 这样可以消除重复的最终内容，但会让共享的相邻 Agent 操作依赖消息用途。child 可以显式交接最终结果，运行时结算则继续作为它的独立后备和终止记录。

## 后果

- 普通可继续调用无需写出 `run_in_background: true` 即为非阻塞；串行委派需要显式选择 `false`。
- 同一条 assistant 消息中的独立 subagent 调用会在工具循环的并发安全分发下重叠执行；有依赖的前台调用仍可逐个发出。
- parent 指引、工具 schema、运行时解析和结算投递陈述同一个默认值。
- child 可以发送一份自包含的最终结果，也可以更早发送重要发现。每次 Activation 还会产生无条件结算通知，因此已完成的运行可能两次投递相互重叠的最终内容。
- 一次性后台 Task 与禁用后台的工具实例保留现有行为。
