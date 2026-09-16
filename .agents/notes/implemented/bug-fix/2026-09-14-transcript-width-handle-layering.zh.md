# Agent Note: 正文宽度拖拽条位于 Chat 内容下方

Status: implemented

[English](2026-09-14-transcript-width-handle-layering.md) | 中文

## 问题

Conversation shell 将每个正文宽度拖拽条渲染为阅读列旁的全高绝对定位区域。较高的堆叠层级使该区域盖在会合理溢出阅读列的宽 Markdown 表格之上。拖拽条的高亮会遮住表格内容，其指针目标也可能取代表格自身的交互目标。

## 决策

Conversation shell 将宽度拖拽条保持在第零层，不创建覆盖整个 body 的堆叠上下文。Chat 只将具体的表格元素提到第一层，阅读列、限定在列内的工具卡片与表格 breakout 包装层都不创建新的堆叠层级。因此只有表格的可见盒子实际延伸进沟槽时才会占有指针；能容纳在正文中的四列表格不会阻断旁边的沟槽拖拽。消息的固定定位 Tooltip 保持在表格堆叠上下文之外，仍可绘制在粘滞 composer 上方。

该规则依赖交付的 Chromium 引擎不会把 ChatView 的 inline-size query container 变成中间堆叠上下文。back-to-bottom 控件能高于粘滞 composer 也已依赖相同的引擎行为。Chromium 命中测试固定这一假设；如果改为提高整个 Chat root，其透明全宽盒子反而会重新占用沟槽。

宽度拖拽条仅使用主指针按键开始调整。拖拽条上的普通滚轮输入会从像素、计算后的行高或页面单位规整为像素，再转发给直接相邻的 transcript scrollport，因此指针悬停在沟槽时不会中断阅读滚动。Ctrl+滚轮表示浏览器缩放或触控板捏合手势，不会被转发。

每侧的命中区域最宽为 10px。悬停指示线使用对比度更低的静止滚动条颜色，线宽 2px，中心实色段长 16px，两端各渐隐 28px，可见总长度为 72px。

Composer chrome 保留更高层级，因此完整的粘滞底部区带刻意不会开始宽度调整。如果拖拽条在进入该区带之前已获得指针捕获，它会临时提到第八层，使指示线在松开前保持可见。占据完整 View 的 composer takeover 仍会完全隐藏拖拽条。

## 考虑过的替代方案

**将拖拽条移到离阅读列更远的位置。** 宽表格可以使用 transcript 的可用宽度，因此固定增加间距只能减少部分窗口尺寸下的重叠，还会让拖拽条更难触达。

**只要 transcript 包含宽内容就禁用拖拽条。** 一行宽内容会让整个 Session 都无法调整宽度，包括与其他行相邻的空白沟槽。

**在 JavaScript 中检查指针下方的元素。** 动态命中测试会重复浏览器的堆叠与指针分发规则，并且仍可能与新的插件 renderer 不一致。

## 后果

可见 Chat 内容只在其可见元素实际延伸进宽度拖拽区域时拥有指针输入，裸露沟槽则保留更轻的宽度调整提示、主按键拖拽和 transcript 滚轮滚动。单元测试固定声明的拖拽条尺寸、指针按键行为、直接 scrollport 查找、缩放排除和每种 DOM delta mode。Chromium `elementFromPoint` 覆盖证明溢出表格获得指针命中，而可容纳的 `md-table-wide` 包装层不会；消息操作测试证明固定定位 Tooltip 仍绘制在粘滞 composer 上方。
