# Agent Note: 保持页面实例的 Desktop 浏览器 webview

Status: implemented

[English](2026-09-20-desktop-browser-webview.md) | 中文

## Problem

iframe 无法提供跨域导航状态, 也无法显示拒绝嵌入的站点. 如果 Tab Body 因选中项或容器变化而卸载, Electron guest 就会丢失表单、滚动位置与原生 history. 页面生命周期因此必须独立于可见性和布局变化.

独立的 per-tab 存储也会阻止同一 Workspace 内相关页面共享站点登录态。页面生命周期与存储需要不同的所有者。

## Decision

Desktop 通过 `ElectronWebViewImpl` 使用 `<webview>`; Web 保留显式启用的 iframe 载体. [Sidebar Browser 决策](2026-09-16-sidebar-browser.zh.md)负责共享 Tab 行为与 iframe 限制; 本文负责 Desktop 载体和按 Workspace 共享的分区.

[Sidebar 稳定挂载决策](../architecture/2026-09-20-sidebar-retained-tab-layout.zh.md)负责真实 CSS 布局中的保活会话与 Tab 容器。Workspace 存储所有权与 guest 基础安全配置仍由本文负责。

- `BrowserController` 负责地址命令与可恢复的展示状态。原生 history 留在 guest 内；真实 URL 与标题观察更新持久化地址。
- 控制器注册表按 DSH Session 索引，不依赖呈现绑定的存活期。重新绑定只替换存储写入方，不重建页面。
- `electron/pages.ts` 组装 Electron 导航提供方和呈现对象. `ElectronWebViewImpl` 负责 guest 租约与原生导航; `ElectronWebviewPresentation` 创建标签并挂载到 Sidebar 持有的内容容器内.
- Desktop Browser 类型声明 `keepMounted`。Sidebar 在隐藏和停靠切换时保留其 DOM 祖先，CSS 负责布局与裁剪。停靠手势期间禁用 guest 指针输入，Body 内的放置提示使用普通层叠。物理卸载会取消未完成的挂载并释放 guest，之后重新挂载时从已知地址重建。
- tab occurrence 取消、插件卸载与窗口销毁会释放 guest。guest 崩溃留下可重试的失败状态；刷新创建新 guest。应用重启展示保存的标题与 URL，等待显式恢复；用户恢复或提交地址之前不创建 guest。不恢复页面内存或原生 history。

标准 `./types` 子路径通过仅指向声明文件的 `types` 条件导出共享的租约、申请结果、打开请求与桥接声明，Desktop 消费方使用 `import type`。这些声明没有运行时 default、额外 JavaScript 产物或提前进行的 Host 打包。preload 只暴露限定范围的操作与回调，不暴露原始 IPC 或 Electron 对象。

Browser 分别拥有 Host 与 Client 编译程序。Desktop 和 Host 聚合配置只引用 `tsconfig.host.json`，编译包根与共享桥接声明；Client 聚合配置通过 `tsconfig.client.json` 编译浏览器实现。包根 tsconfig 只作为 solution。这样，依赖生成 `/remote` 声明的 Client 消费方不会进入 Typert 生成之前的 Host 编译阶段。

### Storage ownership

`DesktopBrowserGuests` 为每个规范化 CWD 存储账号分配随机、非持久化的 Electron partition。Client 使用 Host 规范化后的 `WorkspaceView.path`，不使用 Workspace 记录 UUID，因此在同一目录重建 Workspace 不改变存储账号 key。DSH Session 解析到同一 CWD 的 Browser Tab 共享账号；没有可解析 Workspace 的 Session 仍单独隔离。Workspace 归属在 Client 收到权威基线后解析，并在一次 guest occurrence 内保持不变。CWD key 控制共享关系，不决定是否落盘。

关闭 tab 只释放它的 guest，不清空账号的 Cookie 或存储。Cookie、localStorage、IndexedDB、Service Worker 与缓存由 partition 持有，并继续遵循普通 origin 规则。DOM、原生 history 与 sessionStorage 仍由页面持有。账号 partition 在同一 Electron 进程内重建窗口后仍保留，但不跨应用退出持久化。

### Initial guest policy

只有主应用窗口启用 `webviewTag`。主进程只接受该窗口应用顶层 frame 发起的 guest 申请，并在放行前校验一次性租约、partition 与无活动内容的初始 `about:blank` 文档。主进程替换 renderer 提供的偏好：不启用 Node integration、guest preload、嵌套 webview、plugin、不安全内容、模态对话框或拖放导航；sandbox、context isolation 与 Web security 保持开启。

guest Session 不注册应用协议，也不继承应用的认证请求转发。权限请求与检查、设备访问、屏幕捕获、下载、原生弹窗与 HTTP 认证提示全部拒绝。通过检查且不带 POST body 的直接 HTTP(S) 弹窗请求，通过活动租约路由为新 Sidebar Tab；脚本操作空白窗口和 POST 弹窗流程仍不支持。导航接受不带内嵌凭据的 HTTP(S)；请求过滤拒绝本地文件、特权协议与已知 DSH Host 地址，包括常见 loopback 别名。这不是通用的私有网络或 DNS rebinding 防火墙。

Desktop toolbar 没有关闭 sandbox 的开关。实现不增加远程调试端口或 browser-use 集成。未来的自动化提供方需要经过认证、限定 target 的 broker，而不是访问全部应用 target。把 target/生命周期句柄与导航命令分开的方式，与 Playwright 的 Android WebView 和 Page 对象区分相同；设备级输入属于另一项职责。

## Alternatives considered

**在按可见性挂载的 tab body 内渲染 guest。** 卸载会断开 guest；直接挂载需要 Sidebar 提供 Body 保活与稳定祖先机制。

**在可见与隐藏 DOM 容器之间搬移 guest。** Electron 44 的 `WebViewElement.disconnectedCallback` 会 detach guest 并重置内部实例。保留元素引用或 React key 不能保留该实例，因此父节点保持固定。

**每个 tab 使用独立 partition。** 这会隔离相关页面的站点账号。Workspace 所有权提供所需的共享，同时不共享应用 Session；每个 tab 仍拥有独立 guest。

**修改活动 webview 的 partition。** Electron 在首次导航前确定 partition。选择其他隔离粒度需要替换 guest，并明确已有站点数据的处置策略，而不是实时切换属性。

## Consequences

Sidebar 持有的稳定祖先保留页面，无需 Browser 自行处理几何或遮挡。隐藏 guest 保留页面内存，也可能继续联网；当前没有空闲回收策略。持久化存储、可选择的隔离级别与权限授权 UI 留作独立工作。临时 Workspace partition 是当前策略，并不意味着 Workspace 隔离必然要求临时存储。

定向测试覆盖原生导航错误恢复、preload 监听范围和已迁移的 iframe 行为。这些测试不能确认真实 Electron 的挂载时序、遮挡、焦点、平台样式或存储隔离；这些仍是运行时验证缺口。本次变更不附带 GUI 录像。此实现不构成完整浏览器安全策略已经可以发布的证据。

包内的 Electron 提供方、呈现适配器、页面工厂与 Workspace 存储解析集中在 `src/client/electron/`. 在原生 Electron 测试环境覆盖 guest 行为之前, 该目录暂时不参与逐文件覆盖率门禁; 其单元测试仍然运行. 共享 Browser 控制器、恢复 UI、iframe 代码和 Sidebar 保活仍遵循现有覆盖率要求.
