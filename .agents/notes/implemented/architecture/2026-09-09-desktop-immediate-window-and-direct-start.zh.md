# Agent Note: Show the Desktop window before starting the Host

Status: implemented

[English](2026-09-09-desktop-immediate-window-and-direct-start.md) | 中文

profile 修改与恢复遵循[直接修改 profile 决策](2026-09-09-desktop-in-place-profile.zh.md)。

## 问题

等待后端就绪会让用户在准备 profile 和加载模块期间看不到窗口。完整的 staging 健康检查进程会在应用启动服务进程前重复启动后端，而插件在实际服务进程中仍然可能启动失败。

## 决策

Electron 在 profile 校准或 Host 启动前创建带本地加载页的主窗口。该页面仅依赖已打包的壳资源，并通过自有 preload 接收 starting、ready 或 error 状态。就绪后在同一窗口加载产品 UI；启动失败时显示诊断和可用恢复操作。加载期间关闭窗口会取消后续启动工作，并等待正在启动的子进程退出。

主窗口提供恢复操作，因为失败的 Host 无法提供自身控件。错误页保留诊断、重启和重装指导。只有已打包应用加载了运行时元数据且资源可用时，才提供禁用插件和重置 Desktop。重置会删除 profile 中除所持锁文件外的所有内容，不保留备份；共享产品数据和 Harness-home 环境文件保持完整。profile 目录保持原位，避免清理期间另一事务获取替代锁。preload 不可用时，独立恢复控件使用被拦截的表单导航。渲染进程崩溃会使导航缓存失效，以重新加载启动页。

Desktop 直接准备 profile 后启动实际 Host，不另行启动健康检查后端。包修改保留依赖验证、获准生命周期构建、运行时标识检查和锁。失败后保留部分修改，供显式修复；不自动回滚 profile。

本决策部分取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)和[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)中的 staging 后端探针与延迟创建主窗口。这两份记录仍保留发布、签名、传输、资源归属与依赖事务的理由。完整运行时文件验证仍属于打包操作。

## 考虑过的替代方案

**保留完整 staging 健康检查。** 它可以在激活前拒绝部分启动失败，但会执行两次插件初始化，也不能保证服务进程能够启动。实际 Host 结果提供显式恢复所需的诊断。

**在就绪前隐藏主窗口。** 这避免显示加载页，但后端加载期间用户看不到进度，也无法交互。壳拥有的页面可以在 Host 启动失败时继续使用。

## 后果

用户可以在产品 UI 可用前看到启动进度并从失败中恢复。窗口能够响应不代表后端已经就绪，启动延迟仍需通过已安装产物测量。激活失败后，profile 修改保留在原位。

验证覆盖 Host 延迟时可见的加载页、新 profile 只启动一次服务进程、同一窗口中的失败与重试、恢复期间的插件管理，以及子进程正在启动时关闭应用。安装后 GUI 证据补充生命周期与事务测试。
