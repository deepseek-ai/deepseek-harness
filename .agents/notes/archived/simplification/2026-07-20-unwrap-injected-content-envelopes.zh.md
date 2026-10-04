# Agent Note: 注入内容逐字投影，去除 XML 封套

Status: implemented
Archived: 2026-09-30

[English](2026-07-20-unwrap-injected-content-envelopes.md) | 中文

## 问题

两类注入的会话内容在渲染进模型 transcript（文本记录）时被包在 XML 封套里：`steering/message` 包成 `<steering source="…">…</steering>`，`context/message` 包成 `<context source="…">…</context>`（后者有一个 `'raw'` 退出选项可跳过封套）。这些封套意在告诉模型「这是注入内容，不是用户在说话」。

两个问题：

- **没有模型在这些标签上训练过。** `<steering>` 和 `<context>` 是任何模型都未被教会去读的任意标记，因此这层框架只是徒增 token 而没有可靠效果，还可能起反作用——已录制的 transcript 显示，模型会把 `<steering>` 指令当成第三方元数据而拒绝服从，只回答原始提示词。
- **会话表层是承载框架的错误层次。** 表层的职责是把持久日志投影为模型 transcript；决定内容如何措辞并不是它的事。想要特定框架的调用方可以在注入前自行格式化内容——唯一的重度生产方（`agent-instructions`）本就这样做，它自带完整的 `<system-reminder>` 框架，并用 `envelope: 'raw'` 退出 `<context>` 封套。剩下的标签机制（`ContextEnvelope` 类型，以及贯穿 `InjectOptions`、`HookContext`、`context/message` 事件和 agent loop（智能体循环）的 `envelope` 字段）所服务的区分，本应归属调用方。

## 决策

注入的会话内容逐字投影，框架由调用方自行负责。`deriveEventMessage` 把 `user/message` 的内容块原样送达模型；`source` 保留在持久事件日志中，但不渲染。

`ContextEnvelope` 类型和所有 `envelope` 字段都被移除——包括 `SessionEventMap` 中的 `context/message`、`InjectOptions`、`HookContext`，以及 `dsh-agent-loop` 中 `inject()`/`additionalContexts` 的相关管线。`agent-instructions` 不再请求 `'raw'`；它自带框架的内容渲染方式不变。`renderTagged`/`renderContextEnvelope` 辅助函数被删除。`context/message.meta` 仍携带持久的、对模型隐藏的 JSON 状态。

`source` 来源信息保留在持久事件上，不渲染进 transcript。

## 权衡的替代方案

- **保留 `<context>` 封套，只对 steering（中途引导）去封套** —— 会为一个没有模型会读的框架位保留 `ContextEnvelope`/`envelope` 机制，并保留主要生产方本就退出的那种不一致。
- **仅对插件来源的内容保留 envelope 字段** —— 会按 `source.kind` 把一条投影拆成两条，却没有观察到任何收益；插件引导 agent 时（钩子桥接器的轮次续行原因）同样希望指令被遵从，而不是被贴标签。
- **把去封套的逻辑移入适配器** —— 规范投影就是模型可见约定（「模型可见 ⟺ 已记录」）；让各适配器在框架上各行其是，会使派生的 transcript 依赖于适配器。调用方确实想要的框架应放进调用方自己的内容里，而不是适配器。

## 结果

- 中途引导与注入的上下文以与普通用户提示词相同的权重到达模型。
- transcript 不再区分注入内容与用户消息；需要这一区分的消费方读取持久事件日志，其中事件类型、`source` 和 `meta` 完整保留。
- `hook-{cc,codex}-stop-continue` ACP（Agent Client Protocol）快照已重新录制：旧录制捕获的是模型把 steering 当作第三方元数据而拒绝服从，正是本次修复针对的失败模式。
- [内容块词汇表 Agent Note](../architecture/2026-06-11-content-block-vocabulary.zh.md) 中关于带标签封套的条款已修订为指向本文。

## 推迟事项

`agent-instructions` 已经自行为内容加框架：它把一个完整的 `<system-reminder>…</system-reminder>` 块作为消息内容发出，而不依赖表层封套。这种调用方自有的模式才是应保留的——表层逐字透传内容，任何框架都住在生产方自己的内容里。

曾经存在两条框架路径——调用方自行加框架（`agent-instructions` 的 `<system-reminder>`），以及表层封套（`deriveEventMessage` 加上的 `<context>`/`<steering>`）。本次变更移除了后者，只留下调用方自有的框架。如果未来又需要带标签的框架，应由事件的 `meta` map（生产方附加、对模型隐藏的元数据字段）来统一它，交给专门的渲染器或适配器消费，而不是在 `deriveEventMessage` 中重新硬编码标签。生产方在 `meta` 中声明所需的框架，由一个渲染器统一施加；会话表层的投影始终保持逐字透传。
