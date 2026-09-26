# Agent Note: macOS hidden titlebar with vibrancy sidebar

Status: implemented

[English](2026-09-13-macos-hidden-titlebar-vibrancy.md) | 中文

## Problem

桌面应用此前使用 macOS 原生标题栏：Web UI 上方一条不透明的横条，重复页面已有的窗口装饰、占用纵向空间，并让侧边栏无法触及窗口顶边。窗口看起来像浏览器标签页而非 macOS 应用，且不存在任何按平台差异化呈现的机制——macOS、Windows 与纯 Web 上每个像素都完全一致。

## Decision

Electron 主进程在 darwin 上以 `titleBarStyle: 'hiddenInset'`、`trafficLightPosition: { x: 16, y: 18 }`、`vibrancy: 'sidebar'`、`visualEffectState: 'active'` 与透明 `backgroundColor` 打开主窗口。`'active'` 让窗口失焦时材质保持稳定；`'followWindow'` 会在失焦时把侧边栏冲淡。

所有 macOS Web 侧调整均以 `html[data-platform='darwin']` 为开关，该属性仅由桌面 preload 设置（`document.documentElement.dataset.platform = process.platform`）。这些规则不适用于纯 Web 或其他桌面平台。[Windows 顶栏决策](2026-09-16-windows-desktop-titlebar.zh.md)负责其独立呈现。

**透明链。** 毛玻璃只透过透明像素显现：darwin 上 `html`/`body`（ui-web base.css）与 AppFrame 透明，中间列铺不透明的 `--dsw-alias-bg-base`，侧边栏列铺侧边栏底色的半透明 `color-mix`，让材质透出。SidebarRoot 自身的不透明底色出于同一原因移到框架列。

**原生主题同步。** 毛玻璃材质跟随 `nativeTheme.themeSource`，后者默认跟踪系统外观，会与应用自身的主题偏好背离。ui-theme 引导脚本与 ui-layout 的 `ThemePresenter` 发布 `html[data-ds-theme-source]`（`light`、`dark` 或 `system`；固定偏好——包括注册主题 id——发布其解析后的配色）。应用 preload 观察该属性并经 `dsh-desktop:native-theme-set` 转发；主进程校验取值与发送者（主窗口的 WebContents，包括其本地静态 Web 文档）后赋给 `nativeTheme.themeSource`。发布偏好而非解析值，可在偏好为 `system` 时保留跟随系统。

**侧边栏顶部条与完全隐藏。** darwin 上侧边栏展开时有一条 52px 的顶部条，避开红绿灯并承载收起按钮；顶部条自己打上 `data-window-drag`，于是它自身那 52px 盒子就是窗口的拖拽区（唯一的 darwin drag 规则由 ui-web base.css 声明），按钮经 base.css 交互规则自行减除。收起侧边栏时整列隐藏——`computeColumns` 接受显式 `collapsedWidth`，AppFrame 在 darwin 桌面传 0——而非其他平台保留的 56px rail。重新打开的入口位于框架 root 作用域的 `shell.leading` 窗口 chrome 座，由 AppFrame 仅在整列隐藏时挂载；ui-sidebar 向其注册 `HeaderLeadingControls`（打开侧边栏 + 新会话，复用 shell 的 inject face 与 locale）。座的位置、面板用于避让的 `--dsh-frame-leading-clearance` 变量，以及早先会话头部座的移除，归 [shell.leading Agent Note](../architecture/2026-09-17-frame-shell-leading-window-chrome-seat.zh.md) 所有。

**窗口全屏标记。** macOS 全屏隐藏红绿灯，围绕它们构建的布局必须放松。主进程在 `enter-full-screen`、`leave-full-screen` 与每次 `did-finish-load` 时经 `dsh-desktop:window-fullscreen` 转发 `isFullScreen()`；应用 preload 的 `syncWindowFullscreen()` 把它镜像到 `html[data-fullscreen]`。消费者：AppFrame 把 `--dsh-frame-leading-clearance` 降到 84px 并把座移到 `left: 12px`，侧边栏 `.topStrip` 把收起按钮移到条带左端，右侧边栏全屏面板把首格 pane 的 dockkit strip 内边距重置回常规 10px。

**拖拽区。** Electron 按 DOM 顺序以窗口几何计算拖拽区，不看层叠，因此外壳只声明一次 `-webkit-app-region: drag`，作用于 chrome 行打在自身盒子上的标记，行自身的盒子就是它的可拖几何；哪些行必须带这个标记由 ui-theme app-region 门禁的 `CHROME_ROWS` 清单拥有，本 note 只保留机制。框架不再声明任何 drag——Windows 标题栏行是那个平台自己的 chrome——因此没有一条固定带子需要匹配某一行的高度。所有可交互内容通过 ui-web base.css 的两条全局规则自行减除：一条 `:is(...)` 选择器让每个交互元素（按钮、链接、输入框、role、`[tabindex]`）退出拖拽，一条 `body > :not(#root)` 规则覆盖所有 portal 到 `#root` 之外的浮层。这两条规则依赖的顺序约定：覆盖窗口且必须可点的表面 portal 到 `#root` 之外（settings 浮层即如此），从而在文档顺序上晚于所有 drag 行；内容容器永不声明 drag——那会覆盖更早挂载的浮层。清单、浏览器车道与人工状态矩阵归 [覆盖契约 note](../architecture/2026-09-19-window-drag-coverage-contract.zh.md)。

**全屏避开红绿灯。** ui-dockkit 把 tab 条起始内边距发布为 `--dsh-dockkit-strip-inline-start`（回退为设计自身的 10px）。右侧边栏全屏形态在 darwin 上对面板主体设 88px，并对每个非首格 split 单元的子树重置为 10px，使得任意分屏深度下恰好只有触及窗口左上角的 pane 避开红绿灯。

## Alternatives considered

**`titleBarStyle: 'hidden'` + 自绘窗口控件。** 重造红绿灯会失去原生行为（悬停图形、全屏过渡）且无收益；`hiddenInset` 保留原生控件，只要求页面绕行。

**darwin 上保留 56px rail。** 浮动红绿灯下的 rail 让窗口角落装饰翻倍，也浪费了收起本要回收的宽度；完全隐藏 + 头部承载重开控件符合 macOS 侧边栏惯例。

**同步解析后的主题而非偏好。** 偏好为 `system` 时转发 `light`/`dark` 会把窗口材质冻结在发送时刻的解析值；转发 `system` 让 macOS 原生持续跟随系统外观。

**在 ui-dockkit 内部处理红绿灯避让。** kit 与宿主无关，不可能知道哪个宿主角落贴着窗口装饰；发布内边距变量把策略留在拥有布局位置的宿主（ui-sidebar-right），kit 只付出一个自定义属性。

**向头部控件加收起状态 prop 管道。** AppFrame 已发布 `data-sidebar-collapsed`；用 CSS 对其判断显隐，避免了可能与框架过渡时间线不一致的第二条状态路径。

## Consequences

- macOS 窗口获得半透明侧边栏与隐藏标题栏，对其他平台零成本：所有规则限定在 `[data-platform='darwin']` 下，该属性仅由 Electron preload 设置。
- 毛玻璃材质跟随应用主题，含第三方注册主题（取其解析配色）。截图与录屏与纯 Web 的平面渲染不同。
- 重新打开控件占据框架的 `shell.leading` 座，是客户端 catalog 中的公开 slot；早先的 `conversation.session.header.leading` 座已移除（[shell.leading Agent Note](../architecture/2026-09-17-frame-shell-leading-window-chrome-seat.zh.md)）。
- 拖拽区归属是窗口级全局不变量：`-webkit-app-region: drag` 只出现在 ui-web `base.css`（作用于 `data-window-drag` 的唯一 darwin 规则）与 ui-layout `AppFrame.module.css`（Windows 顶栏 `.frame::before`）内；其他包依赖 base.css 的退出规则或添加限定范围的 `no-drag`，永不新增拖拽面。ui-theme 的 app-region 门禁把每个 chrome 行的 markup 标记与它的样式表、选择器和写死高度配成一条，并拒绝别处的标记。
- 接受透明窗口 + 毛玻璃在屏幕共享中呈现不同、启动可能闪烁；透明 `backgroundColor` 缓解闪烁。

## Testing

ui-theme 引导与 ui-layout presenter 测试钉住 `data-ds-theme-source` 的发布与清除。ui-sidebar apply 测试钉住 `shell.leading` 注册（组件、locale、共享 inject face）及 teardown 移除；ui-layout 的 app-frame 测试钉住 darwin 下座的挂载。desktop main-startup 测试钉住全屏转发（状态切换、重载、已销毁窗口守卫、仅 darwin 注册），preload-platform 测试钉住 `html[data-fullscreen]` 镜像。ui-theme 的 corner-shape 与 full-round 样式门覆盖新样式表，其 app-region 门禁钉住唯一那条 darwin drag 规则与每个 chrome 行的 markup 标记。
