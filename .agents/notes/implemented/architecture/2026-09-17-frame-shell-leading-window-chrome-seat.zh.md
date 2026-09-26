# Agent Note: 框架持有的 shell.leading 窗口 chrome 座

Status: implemented

[English](2026-09-17-frame-shell-leading-window-chrome-seat.md) | 中文

## Problem

[macOS 隐藏标题栏工作](../feature/2026-09-13-macos-hidden-titlebar-vibrancy.zh.md)在 darwin 上把收起的侧边栏整列隐藏，并把重新打开与 New Session 控件移入会话头部的 slot（`conversation.session.header.leading`），在 `data-sidebar-collapsed` 发布期间由 CSS 显示。但只有会话界面有这个座：选中任何其他主面板（插件管理器或未来的全局面板）时，收起的窗口只剩悬浮的红绿灯压在面板内容上，屏幕上没有任何重新打开控件。每个新面板都得自建 leading 座并重复同一套避让几何。

## Decision

窗口 chrome 属于框架，不属于某个面板。ui-layout 声明第五个 root 作用域子 slot `shell.leading`（single），AppFrame 把它的座渲染为覆盖各列的框架级盒子——仅在 darwin 桌面且 `sidebarCollapsed` 时挂载，即让窗口 chrome 无处安放的全隐藏状态（Windows 的零宽收起保留其固定 caption 控件，该座在那里挂载会出现第二组控件）。座位于框架左上角（left 88px 避开 hiddenInset 红绿灯，top 11px 让 28px 控件对齐会话标题行中线，z-index 15 高于列内容、低于框架浮层），并带 `-webkit-app-region: no-drag`，把自己从下方任何拖拽带中减去。

在同一收起条件下框架发布 `--dsh-frame-leading-clearance: 160px`——红绿灯加座内两个控件占据的行内带宽，自框架左边缘起量。窗口全屏隐藏红绿灯（桌面 preload 把状态镜像到 `html[data-fullscreen]`）：座移入其空出的带宽（`left: 12px`），避让量降到 `84px`。会话标题行是唯一消费者：它 pad `max(0px, clearance - 20px)`（其头部已 pad 20px）。两种侧栏状态下都始于窗口顶带之下的入口页（插件管理器页头）改用 `--dsh-frame-top-clearance`（48px，darwin 框架上无条件发布）做顶部内边距，纵向避开顶带而非行内缩进。

ui-sidebar 把 `HeaderLeadingControls` 改注册到 `shell.leading` 而非会话座，复用 shell 的 inject face 与 locale；因挂载条件归框架所有，组件无条件渲染，其平台判断与 CSS 收起门控被删除，同时解除 ui-sidebar 对 ui-conversation 的依赖。原 `conversation.session.header.leading` slot 按 pre-stable API 规则不复存在（更新所有消费者，不留兼容垫层）；会话头现在自带无会话可用的 `conversation.header.leading` 座（root 作用域、无 Session 也渲染）作为公开扩展点，因窗口 chrome 控件已住进 `shell.leading`，出厂组合中它保持空置。

## Alternatives considered

**保留会话座并为每个面板各加一个。** 每个主面板都要重复座标记、拖拽区减除与红绿灯几何，漏掉的面板会让收起的窗口失去重新打开控件。框架持有的单一座使该保证成为结构性的。

**始终挂载占用方、由 CSS 控制可见性（先前机制）。** 它在所有平台与所有收起状态下都保留死 DOM 和头部的 no-drag 减除，且完全帮不到非会话面板。框架级 TSX 挂载把条件、座几何与避让量发布集中在一个文件。

**同时以右栏全屏为座的门控条件。** 不必要：全屏右面板（z-index 40）在视觉上盖住座（15），且它已让整个盒子退出窗口拖拽，座的几何无法穿透它。

**把避让量作为各消费者硬编码的固定内边距。** 各面板写死 `160px` 会与座的真实带宽悄然失同步；在恰为挂载条件下发布一个自定义属性，几何变化时消费者仍保持正确。

## Consequences

- 侧边栏隐藏时，现有与未来的每个主面板都免费获得重新打开与 New Session 控件；会话接入 `--dsh-frame-leading-clearance`，入口页改用无条件发布的 `--dsh-frame-top-clearance`。
- `conversation.session.header.leading` 从客户端目录中消失；`shell.leading` 作为公开 root 作用域座承载窗口 chrome，会话头无会话可用的 `conversation.header.leading` 则是另一个公开座，出厂组合中无占用者。
- ui-sidebar 不再依赖 ui-conversation（inject 列表、devDependency 与 tsconfig 引用均已移除）。
- 挂载条件显式点名 darwin：Windows 的 `data-windows-titlebar` 收起同样得到零宽列，但保留自己的固定 caption 控件，框架座会与之重复。未来某平台若隐藏整列且不留自己的 chrome，通过放宽该条件接入。

## Testing

ui-layout 的 app-frame spec 钉住 darwin 收起下座的挂载/卸载及 56px 控制栏旁座的缺席；apply spec 钉住五 slot 声明与拆除。ui-sidebar 的 apply spec 钉住 `shell.leading` 注册（组件、locale、共享 inject face）及 dispose 时的移除；sidebar-root spec 钉住两个控件的动作。
