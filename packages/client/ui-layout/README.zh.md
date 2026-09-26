---
description: "Web GUI 的外壳布局：三栏 AppFrame（右栏作为贴边面板的轨道）、面板几何服务与主题呈现；供窗口外壳的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的三栏 AppFrame、左右栏宽度与 `ctx.layout` 呈现控制。右栏先让步以保护中栏空间，全屏由占用方呈现，框架保留宽屏底层轨道。主题呈现器负责配色、别名 token、正文字号与 document 元数据；布局状态在刷新后重置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面 Mod+B 通过与控件共用的布局操作切换左侧栏。模态弹窗打开时此快捷键不可用；终端输入优先。

本插件在 root slot 中组合侧边栏、主内容和右栏。侧边栏宽度为 264～420px，默认为 280px，收起后保留 56px 控制栏；窗口宽度低于 1024px 时自动收起，打开右侧面板也会收起手动展开的侧边栏。右侧面板首次打开时使用视口宽度的 45%，之后保留用户的像素宽度偏好，上限为 70%。为给中栏保留 400px，框架先将右侧面板缩减至 300px，再报告空间不足，使占用方将其关闭，最后才进一步压缩中栏。拖动没有过渡延迟；右侧手柄在关闭或全屏时不显示。

全局面板占据 root 作用域的 `main` keyed slot；`conversation` 是为会话界面保留的 key。`ctx.layout.selectPanel(id)` 选中已注册面板，`null` 则选中会话界面，但不改变当前会话。默认组合不注册任何全局面板。

### 窗口 chrome 座

在 macOS 桌面（`html[data-platform='darwin']`，仅由桌面 preload 设置）下，收起的侧边栏整列隐藏而非保留控制栏，框架在左上角挂载 root 作用域的单一 `shell.leading` 座——位于 hiddenInset 红绿灯旁，覆盖所有主面板；ui-sidebar 以重新打开与 New Session 控件占据该座。座挂载期间框架发布 `--dsh-frame-leading-clearance`：窗口 chrome 占据的行内带宽，自框架左边缘起量；内容抵达左上角的主面板以它做内边距，避免落在红绿灯或控件之下。框架还始终在根元素上发布 `--dsh-frame-top-clearance`（48px）：窗口顶带之下的固定下沉量；主面板中的入口型页面（插件管理器等类似页面，非对话）以它做顶部内边距，浮层原语（portal 菜单、底部锚定浮层、设置面板）以它做视口顶部安全边距——放在根元素上让 portal 到 document.body 的浮层也能读到。框架自己不声明任何 darwin drag：每个 chrome 行给自身打上 `data-window-drag`，ui-web base.css 把该标记变成唯一那条 darwin drag 规则，于是行自己的盒子就是窗口的可拖几何——行的空白段可拖，控件保持可点。框架仅剩的那条 drag 规则属于 Windows 标题栏行。

Windows Electron 的 `data-windows-titlebar` 标记在所有列上方预留顶栏高度，并移除收起后的侧栏轨道。内容区仅左上角保留 16px 圆角，其余角和内部交界处保持直角。框架发布 `--dsh-windows-content-radius` 和 `--dsh-windows-sidebar-width`，供 ui-sidebar-right 的全屏圆角及侧栏避让使用。普通 Web 文档不会获得该标记；macOS 保留其独立布局。

### 主题呈现

呈现器消费解析后的主题快照，并投影到 document：`html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，把主题的别名 token 与 `--dsh-content-font-size` 设为 body 上的内联变量，并持有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新。对呈现器执行 dispose（资源释放）时，它会连同其他全局写入一起移除自己的元数据节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`selectPanel(id)` 在改变选中态前检查实时 `main` 注册表；缺失的 key 会抛错并保留当前面板。`beginNavigation()` 为异步 UI 导航返回 abort signal。后续调用、有效面板选择（包括重复选择）或布局释放会中止该 signal，但不取消底层会话创建。消费方在提交导航或搬移草稿前检查 signal。

一次注册声明五个子 slot，并绑定 `ctx.layout` 的 `selectPanel`、`toggleSidebar`、`openRightbar(track, fullscreen)` 与 `closeRightbar`。同一个 root 存储把 `panelInfo` 选中态与 `layoutInfo` 测量、宽度偏好、呈现报告分开。`ctx.layout.panelInfo` 与标准 `usePanelInfo` hook 共用同一个选中态来源；AppFrame 订阅引用稳定的布局对象。`rightbar` owner 提供实际 `width`、`viewportWidth`，以及表示能否以普通模式呈现的 `canShow`；占用方在空间不足时执行确定性的收起，变宽不自行重新展开。全屏隐藏宽度手柄，但不自行释放占用方要求保留的轨道。AppFrame 保持各列容器挂载。右栏的 root 控制器仅在选中会话界面时，经 `SessionProvider` 渲染 `rightbar.session`；内容卸载时的报告释放轨道。独立的标题组件仅在会话界面可见时使用所选会话标题，以构建配置的产品标题或本地化 `common.brand.localBuild` 为回退值；语言变化会更新该回退值。主题呈现器是第二个 effect：从解析后的快照做纯 DOM 写入——初始状态经 getter 读取一次，此后仅事件驱动，不经过 React。它先应用调色板、字号与 token 变量，再把渲染出的背景测量为唯一的颜色依据。全屏呈现禁用网格和手柄过渡；占用方完全覆盖框架后才报告新的列布局。退出全屏时，框架先保持无过渡并安装目标布局：关闭移除右轨道，恢复保留右轨道。后续普通几何操作恢复正常过渡。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当布局面不够用时阅读以下页面。它们从框架进入它所渲染的栏与它所呈现的主题。

- [ui-sidebar](../ui-sidebar/README.zh.md)——占据 `sidebar` 栏及其座位。
- [ui-conversation](../ui-conversation/README.zh.md)——占据 `main` 中的 `conversation` key。
- [ui-sidebar-right](../ui-sidebar-right/README.zh.md)——以每会话一个停靠面占据 `rightbar` 栏。
- [ui-theme](../ui-theme/README.zh.md)——呈现器消费其解析快照的主题 seam。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前布局行为。它们是当前包约束，不是通用窗口管理器对比或任务积压。

- **面板几何是瞬时状态**——重新加载会恢复侧栏默认值并隐藏右侧面板；拖动设置的宽度是整个框架共用的一份偏好，而非每个会话各自的属性。
- **极窄窗口**——右侧面板关闭后，中栏仍可能小于 400px；左侧 56px 控制栏仍会保留。
- **轨道与面板仅在动画期间沿同一条曲线运动**——离散开合时框架设置 `data-animating`，其轨道过渡和占用方的滑入读取同一组时长与缓动变量；占用方若自用一套，挤压时面板边缘就会与会话界面的边缘脱开。拖拽和即时呈现切换不带过渡，因此该曲线不覆盖它们。
- **挤压重排期间无滚动锚定**——布局变化可能移动读者的视口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。外壳中 `ctx.layout` 背后的浏览状态存储不发出 Cordis 事件；clamp 与轨道的时序由本包各栏与服务规格直接断言。
