# Agent Note: Show the Desktop window before starting the Host

Status: implemented

[English](2026-09-09-desktop-immediate-window-and-direct-start.md) | 中文

插件管理和原生恢复遵循[共享 Web 薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)。

## 问题

等待后端就绪会让用户在准备 profile 和加载模块期间看不到窗口。完整的 staging 健康检查进程会在应用启动服务进程前重复启动后端，而插件在实际服务进程中仍然可能启动失败。

## 决策

Electron 在 profile 校准或 Host 启动前创建带打包 Web 加载页的主窗口。Web 入口先显示启动页，再等待 Host 就绪。自有 preload 交付结构化启动注入，现有文档应用注入后激活客户端插件；启动失败时显示诊断和可用恢复操作。加载期间关闭窗口会取消后续启动工作，并等待正在启动的子进程退出。

致命错误展示遵循[原生 Desktop 恢复](2026-09-15-desktop-native-fatal-recovery.zh.md)。窗口展示时机、直接启动 Host 和关闭所有权仍由本文规定。

Desktop 原位准备 profile 后，通过[共享 Web runner](2026-09-10-desktop-web-wrapper.zh.md)启动实际 Host。就绪信息提供认证后的 Host URL 和启动注入。桌面壳用该 URL 换取 Host cookie，转发应用 HTTP 请求，并仅为所属应用源认证直接 WebSocket 请求。此承载适配保留 Web 路由和流语义，同时允许静态 HTML 在 Host 就绪前显示。

本决策部分取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)和[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)中的 staging 后端探针与延迟创建主窗口。这两份记录仍保留发布、签名、传输与资源归属的理由。完整运行时文件验证仍属于打包操作。

## 考虑过的替代方案

**保留完整 staging 健康检查。** 它可以在激活前拒绝部分启动失败，但会执行两次插件初始化，也不能保证服务进程能够启动。实际 Host 结果提供显式恢复所需的诊断。

**在就绪前隐藏主窗口。** 这避免显示加载页，但后端加载期间用户看不到进度，也无法交互。壳拥有的页面可以在 Host 启动失败时继续使用。

## 后果

用户可以在产品 UI 可用前看到启动进度并从失败中恢复。窗口能够响应不代表后端已经就绪，启动延迟仍需通过已安装产物测量。激活失败后，profile 修改保留在原位。

验证覆盖 Host 延迟时可见的加载页、新 profile 仅启动一次服务、同一窗口中的失败与重试、原生恢复，以及子进程启动时关闭。安装后 GUI 证据补充生命周期测试。
