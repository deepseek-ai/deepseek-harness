# Agent Note: 把窗口拖拽覆盖变成契约

Status: implemented

[English](2026-09-19-window-drag-coverage-contract.md) | 中文

## Problem

macOS 桌面窗口的可拖区域被写了两遍。布局决定 chrome 行在哪——它们多高、装了什么；手写的 app-region 声明决定什么能拖：每个 chrome 行一条行声明（侧栏顶条与 logo 行、ui-dockkit 的 strip 行、会话 header、插件管理的页头、Platform 浮层的返回栏），加上散落在 ui-web、ui-settings-general、ui-sidebar-right 的逐盒减除。两份描述靠人肉保持一致，于是会漂：盒子与 band 不匹配的行，要么有 chrome 落在拖拽面之外（就是反馈里的"header 能拖，但有些空白与控制不能"），要么有内容落进拖拽面（点偏几个像素就变成拖窗口，双击那里还会触发系统标题栏行为）。

## Decision

覆盖变成由四部分组成的、可执行的契约：

1. ui-web 的 `window-drag/regions.ts` 把合成规则发布成可执行模型：当包含某点的最后一个 app-region 盒声明 `drag` 时该点可拖，这正是原生窗口施加的按 DOM 顺序的几何合成。它还发布 `INTERACTIVE_SELECTOR`，作为 `data-window-drag` 行和 `data-window-drag-controls` 范围内控件排除的来源。Shell 为每个元素重置继承的区域。不含嵌套拖动行的 `data-window-drag-exclude` 视口仅排除自身矩形，覆盖浮层和含嵌套拖动行的容器单独声明区域。base-styles spec 一并检查选择器、作用范围与重置声明。
2. 外壳只声明一次 darwin 拖拽面：ui-web base.css 里的 `html[data-platform='darwin'] [data-window-drag]`。每个 chrome 行在 markup 里给自己的元素打标，于是该行自己的盒子就是窗口的可拖几何，不需要任何固定 band 去匹配行高。ui-theme 的 app-region 门禁持有一份清单，把每行的 markup 标记与其样式表、类选择器和写死的高度配成一条，并拒绝清单未点名的元素上的标记——行不再打标、新增未打标的行、把标记打在内容容器上，都会在同一条门禁上失败。
3. 浏览器车道增加 `window-drag-coverage`：以 `data-platform='darwin'` 在 Chromium 里启动真实组合，将可点击控件的探测与贡献原生区域的矩形分开。它断言控件不落在拖拽面内，检查每个 chrome 行，并覆盖页头行打标、可滚动正文保持内容的页面。
4. 外壳持有唯一那个重收集 watcher——ui-web 的 `window-drag/recall.ts`，由引导内核安装。在表面可能移动期间，它每帧测量每个被打标的行，凡该帧几何发生变化就在 body 上打 `data-window-drag-recall`；几何在一段很短的宽限窗口内保持不动之后才清掉，这样在 CSS transition 真正移动任何东西之前到达的一次报告，不会在它第一帧未测到变化时就终止循环。它会报告表面可能移动的每一种原因：触及被打标行或承载它的容器的 DOM 变化、被打标行的盒子尺寸变化，以及持有被打标行的元素上开始的 transition 或 animation。任何 chrome 行都不再自带脉冲。

原生那一半——一次按下到底是拖窗口还是到达页面——仍是清单，因为没有无密钥 CI 车道能到达窗口服务器：对本层的任何改动都要走下面的状态矩阵。

## Alternatives considered

**用 JavaScript 测量矩形并发布合成 drag 盒。** 几何得按指针节拍重新推导，而一帧陈旧正是这项工作要消除的吞点击类别；CSS 推导的区域在构造上不可能陈旧。

**全局背景拖拽（`movableByWindowBackground` 的读法）。** 只要不是控件就能拖，会破坏文本选择与空白处点击。

**全局交互元素 `no-drag` 排除。** 原生区域收集使用元素完整矩形，不考虑 `overflow` 或 `clip-path` 裁剪。因此，可聚焦表格或代码块滚出视口后，仍会减除它已不再可见地覆盖的页头。在继承该属性的内核中，子元素还可能将所属容器的排除扩展到其可见矩形之外。显式区域所有者、逐元素重置和控件作用范围使被裁剪内容不参与区域计算。

**每个行在自己的样式表里各声明一条 drag。** 这是本项工作最初的样子，并配一份清单钉住每行高度与覆盖它的 band。那样每个样式表都要复述窗口几何，而且只在布局里移动的盒子仍得在 CSS 里重新声明；改成"markup 打标 + 外壳一条规则"后声明只有一处，清单则继续把标记与门禁能查的几何配起来。

**把当前覆盖钉成一张金标准快照。** 那会把两类故障和正确行为一起冻住；清单把不变量（不得吞掉控件）与缺口（只许缩小的预算）分开。

## Consequences

- 标记拖动行或显式控件范围内的控件无需本地声明，交互选择器会减除它们。范围外的控件不会获得自动排除；覆盖拖动行的浮层必须排除自身矩形。新 chrome 行只需给元素打上 `data-window-drag` 并在清单里加一条钉住高度，无需 band 算术，也不牵动其它样式表。
- 行自己的盒子就是完整的可拖几何，内容容器永远不是。插件管理的详情视图给它们共用的页头行打标，而不是给它所在的详情容器打标：标记容器会让窗口在它的正文与表单 label 上拖动；车道会采样该页头下方的正文来守住这一点。收缩的 sticky 页头通过未标记的外层容器保留静止态文档流高度，标记行采用绘制高度。裁剪更大的标记矩形不会限制其原生拖动区域。
- 每个已声明的 chrome 行自持其拖拽段，门禁断言整个包树只在两处声明拖拽面——外壳的标记规则与 Windows 标题栏行。插件管理页头与其详情视图共用的页头行都把 48px 避让量包含在行内，入口页那条缺口也随之关闭。
- settings 浮层现在与 Modal primitive 一样 portal 到 `#root` 之外，并删掉了它自己那条 no-drag：挂在 root 内的覆盖层先于各列 chrome，后声明的 drag 行会盖掉它的减除；portal 之后由 ui-web base.css 的 `body > :not(#root)` 规则在它与 drag 行重叠处减除。车道在浮层打开时会断言这个归属。由于 onboarding 步骤的浮层只把 `#root` 置为 inert，onboarding 步骤挂载时面板会自行关闭，而不是留在它背后仍可聚焦。
- Platform overlay 的返回栏只是 darwin 的 drag 行。它原先那条按表声明的 `app-region: drag` 没有任何平台限定，因此 Windows 上也能从这条 48px 栏拖动窗口；改到唯一那条带作用域的规则之后，该栏只在 macOS 上声明 drag，在那里它就是窗口顶条。Windows 保留原生标题栏行作为拖拽面，且外壳没有 Linux 桌面目标。人工状态矩阵会为这条栏增加一格。
- 跨越隐藏/显示边界滑动的行不能只靠布局变化：只有当计算出的 app-region 值变化时，Electron 才会重新收集窗口的拖拽矩形（electron#32341），而 Blink 收集时会跳过隐藏的盒子。watcher 一次性把这个缺口对所有行补上——它在"触及被打标行的 DOM 变化"或"被打标行的盒子尺寸变化"时重新启动，随后在盒子仍在移动的每一帧发脉冲——因此右栏不再自带任何脉冲。

## Testing

- `packages/client/web/tests/window-drag-regions.client.spec.ts` —— 合成规则，含顺序敏感与盒子边界。
- `packages/client/web/tests/base-styles.client.spec.ts` —— base.css 声明模型的交互选择器和控件作用范围、逐元素重置、视口排除、唯一那条 darwin drag 规则，以及 recall 标记的减除。
- `packages/client/ui-theme/tests/app-region-styles.client.spec.ts` —— 拖拽所有权、行清单与每行的标记；清单之外的标记或行高变化即失败。
- `packages/client/ui-dockkit/tests/app-region-styles.client.spec.ts` —— 面板、strip 末端 chrome、浮动面板和分隔条排除自身矩形；面板的排除矩形覆盖其正文。strip 行的 drag 属于 markup 标记，因此样式表不声明 drag。
- `packages/client/web/tests/window-drag-recall.client.spec.ts` —— 通过两个 seam 驱动 watcher：什么会重新启动它、什么被它忽略、收敛循环、外壳默认值，以及销毁。
- `apps/web/tests/window-drag-coverage.e2e.ts` —— 真 Chromium：控件与区域所有者分开探测，被裁剪的转录区与标签内容不能减除页头，含浮动面板的全屏右栏保留预期排除，inert 的保留面板不影响前景行。插件管理页头的紧凑态场景检查标记页头的矩形不会延伸到列表控件上方。逐行探测、详情页正文排除、浮层和右栏 recall 脉冲仍有覆盖。
- `apps/web/tests/window-drag-inheritance.e2e.ts` —— 已安装的 Chrome 报告版本，并验证继承的排除、生产重置、显式 `none` 与 `initial` 的区别，以及移除重置的负对照。未安装 Chrome 或运行时不支持属性继承时，显式跳过本场景；断言和其他启动错误正常失败。常规 Chromium 149 车道不实现继承，因此单靠该车道不能验证重置行为。
- 运行时诊断（2026-11-02，Electron 44.7.0 / Chromium 152.0.7977.130）：独立隐藏 BrowserWindow 确认，元素重置前子元素计算为 `no-drag`，重置后为 `none`；显式 `none` 计算为 `no-drag`，`initial` 计算为 `none`。该诊断不加载 DSH 产品代码，仅检查交付内核的 CSS 属性行为，不属于原生状态矩阵验收。
- 真机验收（2026-09-20，双平台，HID 级指针输入 + 窗口矩形读数）：上面的 macOS 矩阵在真实 `hiddenInset` 窗口上跑过，Windows 各格在 Windows 11 ARM64 虚拟机上跑过——chrome 行可拖、正文与覆盖浮层不可拖、控件保留点击、右栏 strip 行在滑入后可拖。

## Manual state matrix

对本层的任何改动都要在打包 macOS 应用上跑。每个格子包含两半：拖该行的空白段（窗口必须移动），点该行的控件（必须生效而不是拖动）。

| 状态 | 要走的行 |
| --- | --- |
| 侧栏展开、选中会话、显示视图 tab | 侧栏顶条、侧栏 logo 行、会话标题行、会话 tab 条行，以及这些行里的每个控件 |
| 侧栏展开、选中会话、单视图（无 tab） | 同上，外加 header 之下的转录区首行 |
| 侧栏收起 | 覆盖中列的 会话 header、`shell.leading` 座的控件、重新打开与新会话 |
| 右栏 push | 面板 strip 行及其控件、strip 下方的 pane body 段、分栏分隔条的顶部一段 |
| 右栏 fullscreen | 红绿灯处的面板 strip 行、首格 strip 内边距、其控件，分别检查有无浮动面板 |
| 入口页（开始页、插件管理、设置） | 含 48px 避让量的页头、它的首个控件行，以及详情页页头行与其正文 |
| 窗口全屏开关 | 以上各行在红绿灯隐藏时、两种侧栏状态各一遍 |
| 在 chrome 行空白段双击 | Windows 上 caption 行走系统标题栏行为（最大化/还原）；macOS 上 darwin 行只是 app-region 区域而非标题栏，因此那里没有系统动作——只有控件保留自己的双击 |
