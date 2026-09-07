# Agent Note: Web 思考尾部滚动 —— 折叠态 reasoning 跟随实时输出

Status: implemented
Archived: 2026-09-04

[English](2026-08-02-web-thinking-tail-scroll.md) | 中文

## 问题

Web Think 行在结算与流式 block 中都把 reasoning 首行渲染成折叠摘要。首行一旦出现，之后每个 reasoning delta 只会改变隐藏的正文。于是快速模型在思考时看起来静止，用户必须展开完整思维链才能确认输出仍在推进。产品事项表已经要求“thinking：滚动展示思维链更新、可展开”；当前行只满足了后半项。

## 决策

只有 reasoning block 是当前流式尾部、且仍处于折叠态的 Think 行会跟随实时输出。其摘要使用最新的非空行，而不是结算后的首行；已有单行摘要元素成为程序化横向滚动区，每次文本更新后钉到 `scrollWidth - clientWidth`。这里刻意直接赋值 `scrollLeft`，通过真实 delta 推进而不虚构独立的跑马灯速度：token 快则移动快，模型停顿则停止，短文本因滚动范围为零而保持静止。

该行为由已有呈现组件拥有。`AssistantMarkdown` 只在 Think 行运行时选择最新行；`ToolRow` 已经拥有折叠／展开状态，因此由它决定摘要是否追随行内末端。不改变 session、wire、持久事件或模型可见约定。展开会移除折叠摘要，并让完整 reasoning 正文进入普通页面流。该行结算后恢复稳定首行，同时把摘要重置到左端。其他工具摘要与已结算 Think 行保留已有省略号行为。

## 曾考虑的替代方案

**播放与流式输出无关的 CSS 跑马灯。** 否决：它会在 provider 停顿时继续移动，让慢模型显得很快，破坏该交互本应暴露的吞吐信号。

**始终显示完整 reasoning 字符串的固定后缀。** 否决：按字符切片可能截断单词或字素，在内容真正溢出前就丢掉当前行的开头，而且只会跳变，无法随每个 delta 移动。

**自动滚动展开的 reasoning 正文或会话页面。** 否决：展开内容是阅读界面，强制跟随会与向上回看的用户争夺滚动；跟随器只属于折叠的单行摘要。

## 后果

折叠行现在会同时通过内容移动和已有扫光传达 provider 节奏，而结算后的 transcript 保持逐字节稳定。滚动更新只发生在流式累加器本就会触发的 React 渲染中；不会增加计时器、动画循环、订阅、持久状态或传输流量。较长的当前 reasoning 行仍会把完整文本留在 DOM 中，只以编程方式裁掉已经溢出的前缀，因此展开仍能显示完整 block，辅助技术读到的也仍是同一份当前摘要文本。

## 测试

`packages/client/ui-chat/tests/reasoning-row.client.spec.tsx` 固定最新行选择、算出的右端滚动位置，以及结算后恢复首行和 `scrollLeft = 0`。`apps/web/tests/lifecycle-chrome.e2e.ts` 中的无密钥组装态 Chromium 场景以可观察节奏回放真实录制的 reasoning chunks，把视口收窄到摘要溢出，并断言实时折叠 Think 行到达真实浏览器的滚动边界。其结算态 replay golden 保持不变，证明历史摘要约定仍然稳定。
