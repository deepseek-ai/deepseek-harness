# Agent Note: toolview 溶解——工具行即 per-view keyed slot

Status: implemented
Archived: 2026-09-04

[English](2026-07-23-toolview-dissolution.md) | 中文

> 范围：独立工具环（ToolViewRegistry/ctx.toolviews/outlet）为何退役、被什么取代。本决策产出的落地态叙述归 [Web 客户端架构注](2026-07-19-gui-web-client-architecture.zh.md)；一切现在所运行其上的注册模型归 [slot 体系标准](2026-07-22-slot-type-chain-implementation.zh.md) 所有。后续的 [Client Tool 展示所有权](2026-08-08-client-tool-presentation-ownership.zh.md) 决策仅取代本篇的 per-view 放置方式：Tool 名称分发仍使用 keyed slot，而非平行注册表。

## Problem

视图环溶解进 slot 体系之后，client 侧恰好还剩一套平行注册模型：工具环——一个具名注册表（`ctx.toolviews`），带自己的 register 文法、自己的 resolve 语义（scoped 压 global 的谓词分发）、自己的 subscribe/version 对、自己的 inject 缓存、自己带私有错误边界的渲染出口。其中每一件都是 slot 机器已经拥有之物的第二份实现，而每一项未来能力（行草稿的 store 席位、i18n 注入、跨 bundle 身份）都将不得不建两遍或漂移。这条环唯一像样的存在理由是：tool 名是运行时开放集，而 `SlotMap` 是封闭声明表——以任意字符串为键的注册表看似结构上必需。

## Decision

工具环作为独立基础设施已消失：工具行是**各视图为自己声明的 keyed 子槽**，client 全域只剩一种注册模型。上述理由是空的——keyed slot 的 *key 空间*本就运行时开放（SlotMap 声明槽、从不声明 key；ask-user composer 的 `key: 'question'` 即先例），开放的 tool 名集合天然适配 `entryKey` 分发。

本决策最初把 `'conversation.chat.toolview'` 放在 chat 条目下，由 chat 渲染点逐行分发。后续的 [Tool 展示所有权](2026-08-08-client-tool-presentation-ownership.zh.md) 将该放置方式移入整体 Tool 席位，并让 `ui-tool` 拥有一个 keyed `'tool.call.toolview'` 子 slot。后续决策改变的是展示所有者，而非本决策的核心约束：Tool 注册继续使用普通 keyed-slot 机制，激活、替换、缓存、错误隔离、版本与 fallback 行为仍归框架所有。

## 接受的语义变化

四项行为增量是刻意接受而非疏漏。跨视图出场最初采用逐视图注册；后续 Note 记录了为何 root/subcall 编排后来证明由一个 Tool 级展示所有者统一负责是合理的。同 key 重复注册从注册表的 later-wins 静默覆盖变为 loud throw——纪律修正而非损失。会话维分发若行需要，归组件内部（标配 kit 已带 `useSessions`），不走注册表谓词——没有已交付的会话变体样例。第三方在 registry 级覆盖形态（scoped 注册压过 global）不复存在；真出现的未来需求走 key 命名空间约定或组件内小 resolver，永不复活平行注册表。

## Alternatives considered

**保留独立注册表（原形态）。** 拒绝：其多维分发的每一维都有更正确的家——展示所有权归显式声明的子 slot，会话维归已持有标配 kit 的组件内部。剩下的只是一份没有任何独有能力的 slot 机器副本。

**把 `renderToolView` 提进标配 kit、注册表迁入 runtime 包。** 拒绝：Tool 展示是 Client UI 词汇；上提进 runtime 会把展示概念泄漏进数据对象层，且依然留着两套注册模型。

**以订阅 refCount 推导槽声明**（首个注册方订阅时隐式声明槽）。拒绝：隐式耦合加去抖复杂度；记为将来真出现多视图 UI 时的备选。

**slots.register 之上的薄 `registerToolView` 门面。** 缓建而非拒绝：溶解后该门面只剩编译期语法糖（slot 名字面量收窄、tool→key 词汇翻译、props 预组合），运行时为零。按「enforce at the operation boundary」（门面不是强制点）保持不建；有用的类型组合以导出的 Tool view props 别名兑现。若重复注册仪式今后足以证明其价值，可在不扰动直接注册的前提下补充门面。

## Consequences

client 只有一种注册模型；审计谁渲染 Tool 调用就是读 slot register 调用，与其他所有 slot 同一套审计。注册方免费获得框架的错误隔离、inject 缓存与 store 席位——没有能力要建两遍。代价即上文接受的语义变化，主要是重复 key 会 loud failure，且第三方无 registry 级覆盖。独立注册方在 `ctx.slots.inject` 中点名有类型约束的 slot，因此依赖关系既显式，又能跟随声明替换，无需服务顺序约定。
