# Agent Note: Desktop 关闭快捷键跟随页面焦点

Status: implemented

[English](2026-09-21-desktop-page-close-shortcuts.md) | 中文

## 问题

[快捷键 PRD](https://trtgsjkv6r.feishu.cn/wiki/APvtwgbztiBLzvk9DM4cQbccnhf) 为关闭命令规定了两类目标：获得焦点的右侧栏页面，或没有可关闭页面时的 Desktop 窗口。Electron 原生 close role 绕过页面 owner。Windows 关闭最后一个窗口还会退出 Desktop 实例并停止其 Host 任务，因此该回退属于生命周期选择，不只是菜单标签变更。

## 决策

侧栏页面 owner 根据实时焦点解析关闭操作，并捕获目标的 Session、窗格、tab occurrence 和导航 revision。它通过资源清理处理器关闭该页面，或收起唯一的停靠引导页。过期侧栏目标不会回退到其他页面或窗口。没有可关闭页面时，Desktop 请求原生窗口关闭；Web 没有窗口回退。

macOS File 菜单通过同一个 owner 路由“关闭页面或窗口”，并显示已接受的单键绑定。原生关闭要求配置 revision 仍为当前值、产品窗口已聚焦且启用，并且没有在录制快捷键。现有窗口生命周期直接生效，不增加快捷键专用确认：macOS 最后一个窗口关闭后保留应用；Windows 和 Linux 退出并停止 Host。

本决策接管[标准 macOS 菜单记录](../bug-fix/2026-09-16-desktop-window-menus.zh.md)中 close role 选择所涉及的 File 菜单和关闭行为。该记录保留原生 Window 与应用隐藏命令的理由。[快捷键偏好持久化](2026-09-20-device-local-shortcut-preferences.zh.md)负责已接受绑定及 revision 发布。

## 考虑过的替代方案

**使用 Electron 原生 close role。** 它不询问获得焦点的页面 owner 就关闭窗口，无法保留页面清理和已接受自定义绑定的路由。

**禁用 Windows 窗口回退。** 这能避免关闭快捷键停止任务，但会遗漏 PRD 明确要求的 Desktop 回退。产品保留原生关窗语义；需要应用继续运行时，用户可以最小化窗口。

## 影响

快捷键与 macOS File 菜单的关闭行为一致。在 Windows 和 Linux 上，焦点不在可关闭侧栏页面时按下该快捷键，可能因退出实例而停止活动任务。该命令不增加后台 Host 生命周期或感知任务状态的退出确认。Desktop 键盘测试覆盖 revision 和焦点保护；侧栏焦点测试覆盖捕获的页面身份和过期目标；启动测试覆盖各平台菜单声明。
