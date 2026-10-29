# Agent Note：`<fallback>` 备选内容取代了 IM 能力层

Status: implemented

[English](2026-10-28-im-fallback-alternatives-replace-capabilities.md) | 中文

## Problem

内置的 IM 运行时在做事之前先回答「这个平台在这个聊天里能不能做 X」。`plugin-im-core` 拥有一整层能力评估——`ChatFacts`、按 bot 的 `FactCache`、`LearnedFact`、`Support`、`element.*` / `message.*` / `limit.*` 键词汇、`evaluateCapabilities` 与 `mergeCapabilities`——每个适配器都从三个方向喂它：模式声明的操作表、适配器钩子，以及按聊天探测的结果。飞书适配器额外加了 `getChat` 探测和五条学习到的事实，QQ 适配器则把被动回复窗口也从同一条通道发布出去。

于是每个消费方都得对答案分支。`@deepseek-ai/dsh-experimental-im` 在消息事件、服务和每一轮输出的 IO 上都暴露 `caps`；summary 与 trace 渲染器发布前要问五六个键；只有 `element.button.action` 与 `interaction.button` 同时答 `native` 的地方才有停止按钮。这层评估在两个方向上都错：`unknown` 对操作必须表示「照做」，对元素却必须表示「不要渲染」，于是一个读不到聊天的探测会悄悄降级工作，而一个答 `unknown` 的探测又让管线从失败里再学一遍同样的事。平台回答之前，关于聊天的一切本来就无从得知。

## Decision

能力层被删除而不是弃用，改由内容本身携带备选。

`@deepseek-ai/satori-element` 新增 `<fallback>` 元素：每个直接子元素是一个有排序的候选，JSX fragment 整体算一个候选，所以 `<fallback><title>…</title><h3>…</h3><text>…</text></fallback>` 是一条消息的三种写法。`normalize` 把每个候选改写成内部的 `<case>`，按 `<fallback>` 所在元素的内容模型归一化，因此行内内容的 fallback 可以并入周围的行内流。`RenderEngine` 渲染整棵子树都能被其注册表原生渲染的第一个候选（标签已注册、变体已声明、结构子节点成立），否则按常规降级渲染最后一个候选；嵌套 fallback 只要自身某个候选可原生渲染就算可原生渲染。选择结果写入 `RenderReport.fallbacks`，`degradationScore` 会为更靠后的候选计费，因此能渲染作者首选的那个模式会赢得每次发布时的模式解析。引擎中没有任何一处查询按聊天的状态。

随之移除的有：`capabilities.ts`、`Bot.supports` / `support` / `capabilities`、`Adapter.facts`、`Mode.operations`、`HandlerOptions.available`、`PlatformError.facts`、`RenderContext.caps` / `supports`、飞书的 `facts.ts` 聊天探测及其学习到的事实，以及 QQ 的被动窗口事实。`LimitKey` 移到 `mode.ts` 并新增 `limit.delete.window`；一个模式能做什么，如今是注册表事实（是否注册该标签、是否声明该变体）、适配器钩子事实（`editPayload`、`deletePart`、`streamDriver`）或声明的上限。`Bot.edit` 与 `Bot.delete` 据此判断，拒绝就是平台给出的、被分类过的 `PlatformError`，而不是预测。

`MessageStream.abort()` 现在会回报撤回是否真的删掉了已发布的消息——这是渲染器无法从自己的内容里得出的唯一问题。

IM 的消费方不再查询能力。`ImOutputIO`、`ImMessageEvent` 与 `ImApi` 去掉了 `caps`；summary 渲染器根据自己打开的流的策略（`patch` / `edit` 会发布临时内容，`final` / `append` 不会）算出渲染计划，并把停止控件写成一个由操作按钮与「回复 /stop 停止」一行组成的 `<fallback>`；trace 渲染器把每段思考与每次工具调用写成一个由可折叠面板与单行摘要组成的 `<fallback>`，把元素预算留给真正有预算的模式。

## Alternatives considered

**保留这层能力评估，另加 `<fallback>`。** 两套机制会回答同一个问题并互相矛盾：渲染器可以问某个模式是否支持 `<details>`，而真正决定这一点的只有该模式自己的注册表。

**为消费方保留一份精简的同步能力描述。** 渲染器只需要三个答案（打开的是哪种流策略、撤回是否成功、按钮是否可点），每一个都已经由事件、调用本身或内容本身给出。「这个平台能做什么」的描述会重新引入让这层评估出错的猜测。

**按聊天惰性探测并缓存答案。** TTL 只是把猜测挪了位置，并没有消除它：禁言、白名单拒绝或编辑策略都可能在两次发送之间变化，而过期的 `false` 会挡住一次本来能成功的调用。

## Consequences

一次拒绝要付一个往返并作为错误浮出水面，而以前这层评估会提前拦下它。需要优雅降级的内容现在在自己的内容树里说明，于是决定权落在清楚自己在渲染什么的渲染器上，而不是一张键表里。各模式在 `assemble` 与 `check` 中自己负责元素预算；trace 渲染器不再预先折叠面板。适配器不再缓存任何关于聊天的东西，因此 bot 不需要探测、TTL 和失效处理，QQ 的被动记账只回答流驱动问的那一个问题（`remaining()`）。

语料新增了 `fallback` 用例，而 conformance 的文本保全检查会跳过 `<fallback>`：渲染哪个候选是模式的属性，因此没有哪段文本是被普遍保全的。被放弃的是「不试就知道这个聊天能不能做 X」——QQ 与飞书 `230075` 的路径以前靠它提前选择缓冲式流，现在依靠被分类为 `limit` 的错误撤回并重发。
