# Agent Note: 将 PTC mode 子分发结果的持久化副本纳入 spill 机制

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-ptc-dispatch-log-spill.md) | 中文

> 范围：用既有的 spill 实现限制 `tool/code-dispatch` 事件的内容。[宿主侧基础 Agent Note](2026-07-26-ptc-dispatch-ui-foundation.zh.md) 有意接受了不设上限的日志，并把 spill 支持留到本次更改；[实时并行 Agent Note](2026-07-26-ptc-live-parallel-dispatch.zh.md) 定义了该监听器处理的事件对。

## 问题

加入完整内容的分发日志后，读取大文件的 `run_code` 程序会把完整的渲染文本写进会话日志，既没有上限，也不经过 spill 策略；原生结果则会在记录之前限制在 `maxInlineBytes` 以内。两类结果受到不同处理，而为批量数据工作设计的子调用最可能产生巨大结果；每个受影响的轮次都会让 JSONL 增长数 MB。

## 决策

**在注册表上增设 `tools/ptc-dispatch-log` waterfall（瀑布式事件），spill 策略作为其第一个监听器。**

- **扩展点**：`tools/ptc-dispatch-log` 是一个按作用域过滤的 waterfall，桥接层会在追加 `tool/code-dispatch` 之前，对每个已结算的子分发运行它。桥接层通过 `RunCodeBridgeOptions` 以能力闭包形式接收注册表私有的 `shapeDispatchLog` 调用器；waterfall 是公开约定，该调用器不会增加服务方法。监听器抛出异常时，调用器会安全地报告任意抛出值，并使用原始的已结算内容。`PtcDispatchLog` 载荷包含外层执行、`agent` 路由键、子调用标识和默认内容；默认内容是原生 `tool/result` 会携带的渲染后结果投影，而程序收到结构化 `value`。监听器只能替换持久化副本，模型不会看到这份副本。监听器作为受跟踪任务在程序的返回路径之外运行。待处理日志任务超过 `maxParallelSubCalls` 时，有序提交循环会等待，因此慢速 spill 后端会限制后续子调用启动，而不会无限累积待完成 I/O。run 结算仍会等待开放轮次内的全部任务完成。
- **策略**：`dsh-spill-policy` 为该事件注册监听器，并复用面向模型结果的监听器所用的替换代码：相同的 `maxInlineBytes` 上限、预览和定位符、不超上限不变式，以及尽力而为回退。spill 产物以 `dispatch` 为标签，记录在子调用 id 名下。UI 与回放通过被 spill 的原生结果所用的同一路径读取全文，因此两类结果会渲染出相同的信息。
- **一处有意差异**：面向模型结果的监听器跳过 `read`，以防出现 `read → spill → read again` 循环。分发日志监听器也会替换过大的 `read` 子调用内容，因为日志副本不是模型上下文，该循环不会发生，而 `read` 最可能产生巨大的日志条目。

## 曾考虑的替代方案

**在桥接层内部使用普通字节数上限，不存入 spill。** 否决：没有定位符的截断会丢失回放或 UI 可能需要的数据，还会恢复之前更改已经移除的、信息较少的「截断摘要」渲染。

**直接在桥接层内做 spill，即从 `ptc.ts` 调用 `ctx.spillStore`。** 否决：注册表会要求提供 spill 能力。waterfall 把该策略与其他 spill 决策放在一起，并允许组合不加载它；省略 `maxInlineBytes` 时，该监听器仍不执行任何操作。

**让嵌套调用复用 `tools/post-execute`，而不是新增一个事件。** 否决：post-execute 可以修改面向程序的结果，因此嵌套调用有意跳过它，让程序取得完整数据。持久化副本需要一个单独的监听器，在程序取得其值之后运行。

## 后果

会话日志中的 PTC mode 分发条目现在遵守已配置的字节数上限，README 中关于分发日志不设上限的「已知限制」条目现在指向本篇。携带超大分发内容的旧日志仍可回放，因为事件字段没有变化；只有今后的追加包含更少文本。Web UI 经由与原生结果相同的路径，把被 spill 的子调用输出渲染为预览和定位符文本，不需要特殊处理。
