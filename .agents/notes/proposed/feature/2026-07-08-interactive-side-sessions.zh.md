# Agent Note: 交互式侧会话与合并回写

Status: proposed

[English](2026-07-08-interactive-side-sessions.md) | 中文

## 问题

用户可能希望在不改变当前会话主上下文的前提下，探索一个来自活跃会话的问题。现有原语无法提供这种产品形态：[会话存储 fork](../../archived/feature/2026-06-30-session-store-fork-api.md) 创建的是一个未绑定的会话，而 [fork subagent](../../implemented/feature/2026-06-21-subagent-capability-seam.zh.md) 是模型驱动的任务，其 transcript（文本记录）会折叠为一条工具结果。两者都不能给用户一个独立的对话，也都不能在父会话中同时记录结论和产生该结论的侧会话。

## 提案

**侧会话（side session）**是一个普通的活跃会话，从源会话的最后一个已完成轮次 fork 而来，绑定到自己的 agent（智能体），定位为只读顾问，并能**合并回写**一条精简笔记。

- **Fork 并绑定：**用 parent 的平衡 completed-turn prefix、`parentSession`、`meta.isSeeded: true` 与精确 sibling `inheritedEventCount` 创建 child。这组合 `ctx.agents.create({ seed, inheritedEventCount, meta })`；不新增 core service 或 Session-store method。
- **顾问定位：**创建后注入一条插件来源的 `context/message`，告知子会话只做解释，不执行变更或继续任务。保持系统提示词逐字节一致，可在继承的历史上保留提供方的前缀缓存。
- **合并回写：**向子会话请求一条有长度上限的 handback，然后向父会话注入一条插件来源的 `context/message`。父会话的下一次请求在日志所记录的位置看到该消息，保持回放与[请求可重建性](../../implemented/architecture/2026-07-05-reconstructable-requests.zh.md)，无需新增会话事件。
- **呈现：**调用方式、会话切换与 handback 渲染属于首个客户端拥有的界面。本 Agent Note 仅规定与界面无关的机制。

回退产品化、会话树视图、面向模型的侧会话工具，以及 `forkName`/`mergedInto` 元数据均不在本 Agent Note 范围内。一次真实适配器 spike 已验证了源日志隔离、继承上下文、多轮子会话交互，以及合并回写在父会话下一轮次中的可见性。

## 曾考虑的替代方案

- **使用 subagent seam：**否决。侧会话是用户驱动的、客户端可见的，且可能存活超过父会话的一个轮次；subagent 是模型驱动的运行，返回一条工具结果。
- **修改子会话的系统提示词：**默认否决，因为任何字节变化都会从第零个 token 起使前缀缓存失效。部署方仍可选择这种更强的隔离方式。
- **新增 `sidechat/*` 事件：**延后。已标注来源的 `context/message` 已经持久记录内容、生产方和回放输入；只有当某个界面需要差异化渲染时，专用事件才有正当理由。
- **现在就绑定一个协议接口：**否决。当前 UI 由客户端拥有。实时呈现最终必须从持久消息派生，以使回放渲染出相同的记录。

## 验收标准

- Fork 不改变 source Session，创建的 child 带有平衡 completed-turn prefix、`parentSession`、`isSeeded: true`、精确 `inheritedEventCount` 与逐字节相同 system prompt。
- 顾问定位在子会话追加历史的头部恰好添加一条插件来源的 `context/message`，而非修改其系统提示词。
- 合并回写恰好添加一条有长度上限的 `context/message`，来源为 `plugin: sidechat`；父会话的下一次请求与回放在相同位置看到它。
- 父会话与子会话并发运行，日志和流之间无串扰。
- 单元测试覆盖 fork/attach 与合并回写；快照覆盖随首个绑定界面一起落地。

## 风险

- 只读行为在 `tools/pre-execute` 拒绝门禁强制执行之前仅为建议性质；[拦截点](../../implemented/feature/2026-06-30-interception-extension-points.zh.md)可在不改变本机制的前提下添加该门禁。
- 经过压缩（compaction）的源会话 fork 出的是其压缩视图，因此绑定的界面应当告知用户子会话继承的是摘要而非被替换的轮次。
- 反复的 handback 会消耗父会话上下文。每次合并的长度上限约束了单条笔记的大小；后续的合并整理属于上下文压缩的职责。
