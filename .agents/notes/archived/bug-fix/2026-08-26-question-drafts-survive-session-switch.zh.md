# Agent Note: 提问草稿在 Session 切换后保留

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-question-drafts-survive-session-switch.md) | 中文

## Problem

`conversation.composer` 是严格按 Session 划分 scope 的 slot，因此选择另一个 Session 会卸载其提问条目。通用 `QuestionFlow` 把当前题号、已选标签、自定义文本和跳过标记保存在 React 组件状态中。因此，即使待处理载体仍归 Session A 所有，一个仍在等待的请求经过 A → B → A 的 Session 切换后，也会以空答案重新出现。

草稿是临时呈现状态：它必须在当前页面内跟随所属 Session，但不能变成待处理业务载体上的可变状态，也不能成为通过 Host settings 同步的用户偏好。

## Decision

提问条目注册到 `conversation.composer` 时声明一个非持久化的 `createQuestionDraftStore` handle。renderer 为每个 Session scope 拥有一个实例，并在选择切换期间保留该实例，因此重新挂载同一 Session 时会读到相同进度。

store 最多保存一个请求标识和一个进度值：当前题号，以及每道题各一份 selected/custom/skipped 草稿。只有本地待处理请求 key 与题目数量都相符时，`QuestionFlow` 才读取已存值。因此，新请求会立即渲染为空，并在首次写入时原子替换旧值，而不会累积请求记录。成功回答和取消落定后只清除与自身相符的请求 key，因此过期的完成动作不会删除较新的草稿。

忙碌状态、失败提示、折叠状态和焦点记录仍留在组件本地，因为它们描述当前已挂载交互，而不是未完成的答案。`plan-review` 呈现界面没有多题草稿，也不读取该 store。

这落实了既有的 [Session scope 规则](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)：需要跨重新挂载保留的状态应归 Session 绑定的数据源；同时保留[由 Host 持久化偏好的决策](2026-08-06-host-backed-web-preferences.zh.md)：草稿仍只存在于当前页面，从不进入 settings、`localStorage` 或磁盘。[多选自定义答案组合](2026-07-30-multi-select-custom-answer-composition.zh.md)规定的答案语义保持不变。

## Testing

store 测试固定按 key 替换和过期清理隔离。组件测试在同一个 store 实例上卸载并重新挂载严格 Session 条目，并要求题号、已选选项和自定义文本全部恢复。无密钥的组装 Web 场景会输入两种答案、切换到新 Session、返回仍在等待的 Session、对恢复后的编辑器生成快照，再经真实提问 waterfall 提交恢复的值。

## Alternatives considered

**继续把状态留在 `QuestionFlow`。** 不采用，因为严格 Session 切换会刻意销毁该 React 实例；组件本地 key 无法比其试图标识的卸载过程活得更久。

**把可变草稿放进 `PendingQuestion`。** 不采用，因为载体表示待处理请求的落定过程，而不是 React 呈现状态；在其中做变更还会绕过 Slot store 提供的订阅读写界面和生命周期归属。

**使用按 Session 和请求建立索引的模块级 map。** 不采用，因为 plugin 重载与 Session 裁剪不拥有其清理过程，已完成请求的条目还可能脱离 renderer 的 scope 生命周期不断累积。

**通过 Host settings 或浏览器存储持久化草稿。** 不采用，因为同一页面内切换 Session 需要的是跨重新挂载连续性，而不是跨页面或跨进程耐久性。持久化会把临时答案文本同步到拥有它的交互之外。

## Consequences

未提交的通用提问答案现在能在当前页面的普通 Session 导航中保留，包括当前题号和显式跳过状态。刷新页面、Session scope 被裁剪或待处理请求标识被替换后，草稿仍会重置。每个 Session 的内存成本被限制为一个请求进度值，并随 Slot store 的 Session scope 一起释放。
