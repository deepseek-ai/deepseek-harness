# Agent Note: 侧栏滚动条的延迟与淡出由 CSS 过渡实现

Status: implemented

[English](2026-11-17-sidebar-scrollbar-fade-in-css.md) | 中文

## 问题

侧栏只在指针位于栏内时绘制滚动条滑块。[指针显示滚动条的 Agent Note](../../archived/feature/2026-08-04-pointer-revealed-sidebar-scrollbars.md) 以离开后 2 秒的 JavaScript 定时器实现了这一行为，之后滑块一步消失。产品评审要求离开后保留 500ms，再明显地淡出（Issue #7921）。那篇 Agent Note 否决了用 CSS 过渡表达延迟；本 Agent Note 推翻这一否决。

## 决策

ui-theme 通过 `@property` 把 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 注册为可继承的 `<color>` 属性，初始值为 `transparent`，因此这组变量的重新绑定可以过渡。`SidebarRoot` 在指针一离开栏的矩形范围时就加上 `quietBars`，不再持有定时器。`.root.quietBars` 规则把两个属性重新绑定为 `transparent`，并带有 `transition: … 200ms linear 500ms`。基础 `.root` 规则不声明过渡，因此显示是立即的；指针在延迟期间返回时，class 在颜色变化前就被移除。在 `prefers-reduced-motion: reduce` 下，隐藏规则设置 `transition-duration: 0s`：时长为零而延迟非零时过渡仍会启动，因此滑块保留 500ms 后在一帧内切换。

过渡发生在栏元素的自定义属性上，而不是滚动条伪元素上。WebKit 滑块的 `background: var(--dsh-scrollbar-thumb)` 与 Firefox 按元素声明的 `scrollbar-color` 在每次样式更新时读取该属性当前的动画值。在 Chromium 中，`apps/web/tests/sidebar-scrollbar.e2e.ts` 逐个动画帧采样解析后的颜色，能观察到先保留、再淡出；删除减弱动态效果规则后，减弱动态效果用例会观察到中间色并失败。

淡出为 200ms 线性，与 SimpleBar 的时序相同。这种浅色滑块若用 100ms 缓动淡出，大部分变化在几帧内完成，看起来像直接消失。

栏内或栏外由栏的矩形范围判定，对到达该栏的每次 `pointerenter` 与 `pointermove` 都会判定。原因是设置面板是固定定位的后代，栏的菜单是 React portal：指针位于其上时这里不会触发 `pointerleave`，而它们的移动事件仍会冒泡到栏。栏自身的 `pointerleave` 处理指针离开窗口的情况。

## 曾考虑的替代方案

**保留 JavaScript 定时器，只用 CSS 做淡出。** 淡出同样需要 `@property` 注册，而组件还要保留定时器、取消逻辑与卸载清理。把延迟移入 `transition-delay` 去掉了这些状态，两个时序也集中在一条声明里。

**不注册这两个属性。** 未注册的自定义属性一步切换，任何过渡都无法保留或淡出颜色。

**由应用自绘滑块元素并淡出其 `opacity`。** 它在所有引擎上都能实现任意淡出曲线，代价是要为替代滚动条承担命中测试、拖动、滚轮、惯性滚动与 hover 样式，指针显示滚动条的 Agent Note 已因收益只是外观而否决了它。

**用 `scrollbar-width: none` 或对 `::-webkit-scrollbar` 设置 `display: none` 隐藏滚动条。** 这会释放预留的滚动条空间，显示滚动条时每一行都会横向移动。

## 后果

注册是全局的：每个读取这组变量的表面现在继承计算后的 `<color>`，而不是 token 文本；不是颜色的值会回落为 `transparent`，而不是让声明失效。只有 `.root.quietBars` 声明了过渡，因此其他表面的时序与颜色都不变；滚动条几何基准快照在两种配色下均未变化。

组件去掉了定时器、document 级监听及其清理。延迟与时长只在样式表中声明一次，`scrollbar-quiet-styles.client.spec.ts` 固定了完整的 `transition` 值。

淡出只在 Chromium 中验证过。Safari 通过同样的 WebKit 伪元素绘制；如果它在过渡期间不重绘滑块，滑块会保留并在约 700ms 后消失，延迟依然生效，只是没有可见的淡出。

在侧栏折叠或展开过程中离开时，滑块会立即隐藏，因为折叠规则的 `transition: width` 声明优先于隐藏规则的声明。
