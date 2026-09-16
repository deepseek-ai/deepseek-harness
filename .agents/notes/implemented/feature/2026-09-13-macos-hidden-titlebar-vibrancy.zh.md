# Agent Note: macOS hidden titlebar with vibrancy sidebar

Status: implemented

[English](2026-09-13-macos-hidden-titlebar-vibrancy.md) | 中文

## Problem

桌面应用此前使用 macOS 原生标题栏：Web UI 上方一条不透明的横条，重复页面已有的窗口装饰、占用纵向空间，并让侧边栏无法触及窗口顶边。窗口看起来像浏览器标签页而非 macOS 应用，且不存在任何按平台差异化呈现的机制——macOS、Windows 与纯 Web 上每个像素都完全一致。

## Decision

Electron 主进程在 darwin 上以 `titleBarStyle: 'hiddenInset'`、`trafficLightPosition: { x: 16, y: 18 }`、`vibrancy: 'sidebar'`、`visualEffectState: 'active'` 与透明 `backgroundColor` 打开主窗口。`'active'` 让窗口失焦时材质保持稳定；`'followWindow'` 会在失焦时把侧边栏冲淡。

所有 Web 侧调整均以 `html[data-platform]` 为开关，该属性仅由桌面 preload 设置（`document.documentElement.dataset.platform = process.platform`）。纯 Web 与非 darwin 桌面的渲染与之前完全一致。

**透明链。** 毛玻璃只透过透明像素显现：darwin 上 `html`/`body`（ui-web base.css）与 AppFrame 透明，中间列铺不透明的 `--dsw-alias-bg-base`，侧边栏列铺侧边栏底色的半透明 `color-mix`，让材质透出。SidebarRoot 自身的不透明底色出于同一原因移到框架列。

**原生主题同步。** 毛玻璃材质跟随 `nativeTheme.themeSource`，后者默认跟踪系统外观，会与应用自身的主题偏好背离。ui-theme 引导脚本与 ui-layout 的 `ThemePresenter` 发布 `html[data-ds-theme-source]`（`light`、`dark` 或 `system`；固定偏好——包括注册主题 id——发布其解析后的配色）。应用 preload 观察该属性并经 `dsh-desktop:native-theme-set` 转发；主进程校验取值与发送者（主窗口的 WebContents，包括其本地静态 Web 文档）后赋给 `nativeTheme.themeSource`。发布偏好而非解析值，可在偏好为 `system` 时保留跟随系统。

**侧边栏顶部条与完全隐藏。** darwin 上侧边栏展开时有一条 52px 的顶部条，避开红绿灯、承载收起按钮，并作为窗口拖拽区（`-webkit-app-region: drag`；按钮退出拖拽）。收起侧边栏时整列隐藏——`computeColumns` 接受显式 `collapsedWidth`，AppFrame 在 darwin 桌面传 0——而非其他平台保留的 56px rail。重新打开的入口移入会话头部：新增 single、session 作用域的 slot `conversation.session.header.leading` 位于面包屑之前，ui-sidebar 向其注册 `HeaderLeadingControls`（打开侧边栏 + 新会话，复用 shell 的 inject face 与 locale）。显隐纯由 CSS 依据 AppFrame 发布的 `data-sidebar-collapsed` 属性控制；不新增收起状态管道。darwin 上空白会话的头部保持 leading 座挂载，确保侧边栏隐藏时屏幕上始终有重新打开的控件。

**拖拽区。** darwin 上会话标题行是拖拽区，所有可交互后代退出。Electron 按 DOM 顺序以窗口几何计算拖拽区，不看层叠：覆盖标题带的浮层必须自行减除，否则下层区域仍会截获指针。因此右侧边栏的全屏面板对整个盒子设 `-webkit-app-region: no-drag`，再在其 tab 条空白处恢复拖拽。

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
- `conversation.session.header.leading` 是客户端 catalog 中的公开 slot；任何包都可占用该座位，ui-sidebar 的占用者假定平台匹配时随时可能渲染。
- 拖拽区几何是窗口级全局不变量：今后任何在 darwin 上覆盖标题带的浮层必须用 `-webkit-app-region: no-drag` 自行减除，否则其控件不可点击。
- 接受透明窗口 + 毛玻璃在屏幕共享中呈现不同、启动可能闪烁；透明 `backgroundColor` 缓解闪烁。

## Testing

ui-theme 引导与 ui-layout presenter 测试钉住 `data-ds-theme-source` 的发布与清除。ui-sidebar apply 测试钉住 leading 座注册（组件、locale、共享 inject face）及 teardown 移除。ui-conversation skeleton 测试钉住 active 阶段头部对 leading slot 的渲染调用。ui-theme 的 corner-shape 与 full-round 样式门覆盖新样式表。
