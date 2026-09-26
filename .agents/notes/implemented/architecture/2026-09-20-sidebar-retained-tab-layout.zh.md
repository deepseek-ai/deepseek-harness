# Agent Note: Sidebar 的稳定 Tab 挂载与会话保活

Status: implemented

[English](2026-09-20-sidebar-retained-tab-layout.md) | 中文

## Problem

恢复各会话的 Tab 记录和 URL, 并不能保留活的浏览上下文. 在 Tab、Pane 或会话切换期间卸载 Body 或改变其 DOM 祖先, 都会断开页面. Electron 44 的 `WebViewElement.disconnectedCallback` 会 detach 并重置 guest, 因此保持 React key 或缓存元素引用不能抵消祖先断开. 内容尺寸、裁剪与重叠也必须遵循真实父节点布局.

## Decision

Sidebar 负责活 Body 的保留，不依赖 Browser 导航和 Workspace 存储。保活页面的 DOM 祖先在切会话、选 Tab、跨 Pane 移动、收起、浮动和回停靠时保持连接与身份不变。Browser Presentation 直接挂载到内容容器内，不做占位元素测量或浮层定位。

### 布局所有权

- `DockLayout` 用稳定的 Tab 兄弟节点渲染 Sidebar 的一个或两个水平 Pane。现有递归 `DockSurface` 和独立 `FloatLayer` 仍可用于通用分割树渲染；布局引擎和序列化格式不变。
- 每个 Tab 都有稳定的 Grid cell、frame、Header 容器和 Body 容器。显式 Grid 列决定停靠归属，Flex 分配 Header 与 Body 的高度。浮动只把同一个 frame 改为 `position: fixed`，不改父节点或替换 Body。
- 浮动 frame 的零尺寸 Grid cell 在浮窗层建立层叠上下文。CSS `order` 表达该层内的浮窗深度，DOM 顺序始终按 Tab 身份排序。大量浮窗置顶不会把层级递增到菜单之上；选中项和 Tab 条排序均不重排内容节点列表。
- 共同祖先不设置 transform、裁剪或包住全部内容的层叠上下文。停靠 cell 负责收起 transform 和显隐，各 frame 裁剪自身内容。Fullscreen 修改同一个根的宽度和停靠层级。右栏不再自带窗口拖拽脉冲：由外壳唯一那个 watcher 在表面可能移动时逐帧测量被打标行并自行脉冲 recall 标记，因此没有布局代码复制内容位置。
- 分栏与浮窗手势沿用原有测量和操作状态，更新用户选择的分栏比例与浮窗矩形，而非维护第二份 Browser 矩形。窗口缩放和内容尺寸变化由普通 CSS 布局处理。

### 会话与 Tab 生命周期

`SidebarRightTabDefinition.keepMounted` 为类型启用懒保活。Desktop Browser 启用它，其他类型继续按可见性挂载 Body。保活 Body 在首次显示时创建，随后隐藏不卸载，直到 occurrence 或提供方生命周期结束。该策略不持久化，也不选择存储分区。

`SidebarSessionView` 使用独立的 `sidebarView` 来源申请、释放一个 `SessionReference`，并管理自己的已提交挂载计数和 Body 保活持有。`SidebarSessionViews` 管理选中、保留策略和视图索引，将生命周期操作委托给视图，而不修改其计数或释放其引用。`RightbarRoot` 接收 `SidebarSessionViewSnapshot` 和已有注入回调，不接收资源所有者对象；它为各视图分别渲染显式 `SessionProvider`，保持会话 key 稳定，渲染器通用的会话重挂载语义不变。

Tab 提供 Body 保活持有，而不独立申请会话引用。View 的稳定 `retainTab` 回调通过 owner props 传给席位，因此替换 Session injection binding 不会释放再重新获取这些持有。这些持有跟随已有 occurrence signal，包括关闭后撤销恢复得到的新 signal；视图不创建第二套 Tab 生命周期。退出视图列表的视图仍留在集合的引用索引中，直到自行释放时移除索引，因此插件关闭时也能清理尚未结束 React 挂载的视图。

只有选中的会话向 frame 报告占位、绑定公共 Sidebar 导航。后台 Tab actions 仍指向自己的已接管存储。`tab.visible` 包含会话和全局面板的可见性，浮动不会让后台会话变成可见。切会话或打开全局面板隐藏整个内容树，收起 Sidebar 则只隐藏停靠 cell，前台浮窗仍可见。隐藏内容不可通过指针或键盘访问，隐藏 Body 内的焦点会被移除。

后台会话没有已初始化的保活 Body 时，从视图列表移除；等已提交的 React 根卸载后再释放引用，避免仍挂载的子树下方先销毁会话 scope。插件释放会清理全部引用，包括等待卸载的已移除视图。Sidebar 插件依赖 `sessions` 和 `uiSession`，任一依赖结束时由 Cordis 卸载它，绑定失效由 `ui-session` 负责。视图不向共享会话 Context 注册销毁回调。仅在目录列表中缺项不视为删除。未访问的 Browser Tab 和无关会话不会提前打开。

### 提供方职责

`BrowserFrame` 仍只负责导航与可观察页面状态。Presentation 创建、挂载载体 DOM，不了解 Pane、裁剪或层叠。Electron 提供方接收物理 attach/detach 回调：隐藏保活内容不触发这些回调，真正卸载则取消未完成的挂载并释放 guest；之后再次物理挂载时从已知地址重建。dispose（资源释放）会等待未完成的创建和 guest 释放，取消后才完成的申请只释放、不挂载。

[Desktop Browser 决策](../feature/2026-09-20-desktop-browser-webview.zh.md)继续负责 guest 安全、共享 IPC 声明和 Workspace 分区所有权。不同 Tab 和会话不能因为共享存储分区就共享一个页面实例。Web 默认仍关闭，显式启用时继续使用 iframe 载体。

### 保活与恢复

| 操作 | 内容处理 |
|---|---|
| 切换 Tab | 隐藏旧的保活 cell，显示目标已有 Body。 |
| 分栏、排序或移到另一个 Pane | 改逻辑归属和 Grid 分配，不搬移 Body。 |
| 浮动、回停靠或置顶 | 改同一个 frame 的 CSS 模式或 cell 绘制顺序。 |
| 收起 Sidebar | 隐藏停靠 cell，前台浮窗保持可见。 |
| 会话 A → B → A | 隐藏并重新显示 A 的原内容树，而非加载已保存 URL。 |
| 关闭、提供方卸载或真实 generation 结束 | 释放 Body 和 guest；撤销关闭创建新 occurrence。 |
| 应用重启或窗口刷新 | 展示保存的标题和 URL，显式恢复或提交地址后才加载。 |
| guest 崩溃 | 通过提供方重试；页面内存和原生 history 不持久化。 |

[布局与提供方恢复](2026-09-14-sidebar-layout-provider-recovery.zh.md)仍然独立：持久化的 Tab 身份、位置和地址支持冷启动，而不是序列化 DOM。隐藏页面可能继续执行脚本、播放媒体或联网。

## Alternatives considered

**只隐藏 Pane。** 可以覆盖收起，但跨 Pane 移动或进入独立浮动 Portal 仍会改变内容祖先。

**只保留前台会话的 Body.** 会话 slot 重挂载会断开页面, 导致切会话时丢失页面运行状态.

**每个 Tab 独立持有会话引用。** 同一视图的 Tab 共用一个 `SessionProvider`，它的引用必须先于这些 Body 渲染而存在。按视图持有即可覆盖父级及其子节点，无须再为每个 Tab 管理一份引用生命周期。

**缓存并搬移 DOM。** 普通 reparent 会触发 Electron 断开处理；实现不依赖原子搬移、私有挂载 API 或生命周期补丁。

**把 Browser 内容放在独立浮层中.** 测量或 CSS 锚点可以对齐浮层, 但内容仍处于负责其尺寸与裁剪的父级 Grid/Flex 布局之外.

**使用原生 popover。** 普通 Portal 内容无法通过 `z-index` 覆盖 top layer 元素。把菜单、对话框迁移到另一套层叠体系会扩大 Sidebar 之外的改动；实现保留既有 Portal 和层级模型。

**通过递增根 z-index 置顶浮窗。** 不设上限的浮窗数量可能越过菜单和模态层。同层 Grid cell 的 CSS 绘制顺序同时保留层叠与 DOM 身份。

**隐藏时保存 URL 再重建。** 无法保留表单、脚本状态、滚动位置和原生 history。这是丢失实例后的恢复，不是活页面保留。

## Consequences

布局正确性由 Sidebar/DockKit 负责，而不是 Browser。代价是稳定的内容容器与显式会话引用所有权：后台保活不仅持有页面内存，也持有会话 scope 和订阅。没有隐式 LRU 或空闲超时，未来回收需要明确的暂停与恢复策略；其他 Tab 类型不会自动承担这些成本。

Sidebar/DockKit 除了负责保活内容布局, 还负责控件、浮窗层级、焦点和平台样式. [停靠基础设施](../feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)负责布局引擎、持久化和 Tab 类型导航; [Desktop Browser 决策](../feature/2026-09-20-desktop-browser-webview.zh.md)负责 guest 导航、存储和安全.

## Verification

定向测试覆盖 Session 数据源注册与注销期间的正文保活、存档布局校验和既有 Sidebar 呈现。Host 与 Client TypeScript 编译通过。用户已手动验收重新构建后的 Electron 冷启动；未录制 GIF。guest 身份、表单与 history 保留、多浮窗绘制顺序、缩放、裁剪、放置提示、焦点和平台窗口控件仍需独立于这些单元测试的真实 Electron 证据。
