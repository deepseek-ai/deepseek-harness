# Agent Note：复用崩溃修复的精确事件会话分叉

Status: implemented

[English](2026-08-18-arbitrary-seq-session-fork.md) | 中文

## Problem

分支可能需要工具结果到来之前的历史，包括父会话已经完成后的历史位置。将 fork 限制到已完成轮次会阻止这种选择。复用崩溃恢复的结果文案则会错误暗示父会话已中断。

## Decision

`SessionStore.fork` 精确接受任意已有的整数事件 seq，并拥有源会话归属、子会话标识和切点校验。`dsh-session/fork` 唯一导出的 `buildForkSeed` 复制含切点的前缀，插入子会话的继承 `session/end-seed` 标记，再关闭开放尾部。Host 从同一份不可变观察中选点和构建。省略 `atSeq` 表示最近已完成轮次及其独立尾部，在下一轮次或排队用户输入前停止。显式 seq 永不移动。

Fork 与崩溃恢复共用相同的工具配对算法。只有开放步骤会在 `step/end` 前补缺失的错误结果；开放轮次随后补 `turn/end`。已关闭的步骤和轮次保持原样，包括缺少结果的历史失败。内部 cause 选择 `forked` 或 `interrupted`、确定性的结果 ID 及模型可见文案。Fork 文案描述缺少的继承记录，并提醒父会话可能已在切点后执行调用。重试建议区分只读或幂等操作与有副作用的操作。

继承标记位于合成结束事件之前。`inheritedEventCount` 只统计复制的父事件；标记与结束事件属于子会话，在 agent 发布前持久化。构造函数仅在给定切点指向最后一个继承标记时接受这种完整 seed。嵌套 fork 在复制前缀中保留祖先标记。`firstLiveSeq` 仍是完整构造输入的长度，与持久继承计数不同。

V4 接受未启动的 fork 结果，不修改已发布的 V0–V3 校验器。其 codec 和关系校验器为这一经过校验的变体提供内部规范 interrupted-result 视图，再返回原始 fork ID 和消息。V3-to-V4 迁移保留已有事件。`forked` 轮次结束原因与已定稿的 V4 头版本变更一起记录兼容性确认。

本决策取代[仅按已结束轮次截取的 Controller 策略](../../archived/bug-fix/2026-09-11-session-controller-fork-turn-cut.md)。显式切点精确保留所选事件；省略切点时保留已完成的独立操作，包括手动压缩的替换事件，直到 core 所属的新轮次或排队输入事件开始。插件继续负责自己的括号关系；Controller 不对插件事件分类。

## Alternatives considered

**将切点移到已完成步骤。** 这会改变显式历史选择，丢失所需上下文。精确切点加已记录的结束事件保留该上下文。

**构建请求时修复。** 模型可见结果必须进入日志，因此 seed 在模型请求之前记录它们。

**修复已关闭步骤中的调用。** 这些失败原本属于父会话；这会将 fork 扩展为新的历史修复策略，偏离崩溃恢复行为。

**公开依赖 Store 的 fork 包装函数。** Store 的创建规则留在 Store；纯 seed helper 只需要事件类型和内部结束函数，避免增加公开入口或搬迁 Store 文件。

## Consequences

Fork 关闭所选开放尾部，不修复更早的畸形历史。插件拥有其未配对括号：不会合成 `compaction/end`。继承标记让 compaction 识别继承而来的陈旧 start。父子序号在切点后分离。 新 fork 的 `firstLifecycleSeq` 从子会话自有标记开始，因此 telemetry 包含合成结果与结束事件。恢复的 Session 从已存储前缀之后开始当前生命周期；仅凭持久化 fork 切点无法识别新的采集内容。聊天操作保留已完成轮次选择；更细的事件选择属于后端功能，不增加 side chat。

## Testing

Session 和 repair 测试覆盖精确切点、两种错误分类、已关闭失败步骤、空历史、插件括号和 surface 替换。Agent-loop 回归验证实际的下一次模型请求、结果保留、轮次编号及不重复执行工具。Host 测试覆盖实时与冷源会话、精确拒绝和排队输入隔离。V4 测试往返原始 fork 结果数据、拒绝畸形结果并验证嵌套 fork。无需密钥的 `fork-mid-turn` 浏览器场景通过 HTTP 对冷录制进行 fork，再通过输入框继续运行，并在预期输出中展示分支文案。
