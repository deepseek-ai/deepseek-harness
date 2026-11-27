---
description: "在 Desktop 中使用原生只读预览打开本地 DOCX、XLSX 和 PPTX 文件，并提供按格式选择的回退。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-office-frame-forwarding

[English](README.md) | 中文

## 概述

可选的“Office 只读预览”bundle 在用户于插件页面启用后激活此包。原生查看支持选择、缩放、分页、工作表导航和演示播放。只读模式下，从已有选区内部拖动会开始新选区；Shift 保留原生扩选行为。预览复用文档顶部工具栏中的文件路径和刷新操作，PowerPoint 播放按钮位于刷新按钮旁。普通 Web 和 headless 配置保持现有行为。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Desktop 中打开本地 DOCX、XLSX 或 PPTX 文件。只读预览使用 FrameForwarding，加载时复用 Web 旋转动画，并显示字体、引擎、文档和首帧四阶段提示。侧栏负责格式路由并渲染回退：XLSX/XLS 使用浏览器表格视图，Word/PowerPoint 使用 PDF。其他格式或 FrameForwarding 不支持时由侧栏直接渲染回退；原生打开失败、引擎崩溃、渲染失败、原生帧不可用、video 后端失败（包括连续呈现失败且期间没有成功写入视频轨道，以及放映播放被拒绝），或来自 Host 的引擎、通道事件流因不可恢复的错误结束时，本插件调用一次 slot owner 的 `onNativeUnavailable`，侧栏随即切换到回退。通道丢失后在配置的额度内自动重连，放映正在等待首个视口时同样可以恢复。只有达到上限时才保留“重新连接”操作。CSV 和 TSV 保留表格视图自身的入口。XLSX 和 XLS 不提供渲染器选择框。首个文档帧提交至视频轨道后显示选区。滚动或缩放时，视频播放可能短暂落后于选区坐标。租约到期时，仍打开的标签会自动重开文档一次；重开失败时显示对应格式的回退预览。手动刷新或源文件变化会开始新的尝试。

切换标签会保留已打开的文档、选区、滚动位置、缩放和静态分页预览。隐藏的 mount 发送不可见 viewport，让引擎回收空闲 surface；返回时重绘当前窗口。关闭标签或切换到回退时释放原生会话。卸载插件时，先等各视图释放文档，再撤销 Office Remote。刷新和源文件变化会打开独立的原生文档，释放旧视图不会关闭当前预览。

多个文档可以同时渲染，例如在多个浮窗中，每个文档只等待自己的工作。图形内存不足时，视图保留最后一张图像，在未覆盖区域显示分页预览或主题底色，并显示等待提示。纹理 credit 超时按有上限的指数退避重试；连续超时达到 `creditRetryLimit` 后，先等待不可见 viewport 确认、回收空闲 surface，再恢复渲染。暂停或隐藏视图会清除等待提示和重试定时器；视图恢复可见并启用后继续处理最新需求。帧转发每通道必须允许至少三帧（`maxFrames >= 3`）。

PowerPoint 放映把文档视图原地全屏显示为模态层，因此覆盖整个屏幕，包括侧边栏控件；播放按钮先请求全屏再开始放映，请求被拒绝时不开始放映。Tab 在放映控件内循环，焦点位于幻灯片或播放控件时都可按 Escape 退出，文档自己因 Escape 退出全屏时同样如此。隐藏放映所在的标签会退出全屏。另一个元素全屏期间（例如另一视图的放映），被遮挡的视图发送不可见的 viewport，其引擎随之停止渲染并归还空闲 surface，直到全屏结束。退出后，同一个文档视图返回预览面板，并显示放映中的最后一页。原生文档成功切换到该页后才恢复预览绘制；切页失败会退出全屏并切换到 PDF。

使用触屏时，单指拖动滚动文档，双指捏合在 25%–400% 之间缩放文档。捏合时保持手指下的文档位置，不缩放整个应用。鼠标拖动用于选择内容；触控板捏合及缩放控件保持可用。Word 中，从已选行的左缩进处起拖也会建立新选区。

在只读 Word、PowerPoint 和 Excel 预览中，单指按住 450 ms，期间移动不超过 8 CSS 像素，然后拖动即可选择原生内容。Word 和 PowerPoint 使用各自的原生文字及对象选区，Excel 选择单元格范围。长按成立前移动会正常滚动。第二根手指加入时结束选区拖动并开始捏合缩放；松手、取消触屏操作、隐藏标签或窗口失去焦点时会释放原生按下状态。长按选区会抑制触屏右键菜单。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

原生预览复用共享 UI primitives 的缩放控件；Office 为 Word 提供适应宽度，为 PowerPoint 提供适应页面。包名不带 `experimental` 前缀，因此它移出实验分组时，引用它的 bundle patch 和 profile 保持有效；依赖隔离和晋升仍由实验性分类约束。

Host 的 `officePreview` 服务拥有文档进程并提供类型化 Remote 操作；每个文档按操作到达顺序执行，不同文档并发执行。加载阶段和引擎事件通过 Remote 流送达。每个打开的标签通过 `retain(documentId, clientId, signal)` 持有文档租约，隐藏时也继续持有。同一渲染进程重新取得租约时会收到最后播放的页码和放映结束状态。新渲染进程接管时，Host 会停止该文档中仍在播放的放映。在放映启动或播放期间刷新时，会先停止放映、卸载旧画面，再释放文档。Client 仅在 Host 可用性报告支持本地渲染时注册原生预览，并保留每个 Office 页面直到所属标签实例取消。每个文档在标签页中挂载一个 video，浮窗也使用同一呈现方式，并基于标签可见性、文档全屏遮挡与显存回收显式控制 mount 可见性。PowerPoint 放映在 Office 视图内直接使用标准文档 Fullscreen API（`requestFullscreen`、`exitFullscreen` 与 `fullscreenchange`）。视图坐标更新独立于绘制成功与否，通道等待重连期间也会更新。指针坐标和 DOM 选区比例使用同一个 content view，并涵盖文档居中偏移。

帧转发归[帧转发包](../frame-forwarding/README.zh.md)所有；Office 不携带原生代码。Host 通过共享的 `officeKit` 服务（`discoverRuntime()` 与 `openDocument()`）探测能力并打开原生文档，由该服务负责 Kit 加载、`app.asar` 外的引擎包解析以及部署级字体和归档配置。每个文档拥有一个通道，通过 `attachSurfaceTransport` 传递 producer 凭据；`channelConnectTimeoutMs` 必须短于 `operationTimeoutMs`。Office paint 请求只携带已确认的 generation，Kit 所需的关联标识由 Host 提供。Host 将 Kit 的瞬时帧错误映射为结构化的 `office/frame-retry` 原因（`stale` 或 `credit-timeout`）；Client 不解析诊断文本来决定是否重试。每次放映使用一个流标识，开关流和调整画面尺寸的请求都属于当前接收通道。停止放映或卸载文档会取消视口等待，包括回收帧额度时等待生产端确认。卸载文档会等已经发给引擎的绘制请求完成。更换通道时会立即卸载旧视频，并丢弃仍在排队的旧放映请求。放映时丢失通道，Host 会在重连前停止放映，并在原生引擎中选中最后播放的幻灯片。预览和鼠标操作都从这一页恢复。自动重连仍受 `automaticReconnects` 和 `automaticReconnectWindowMs` 限制；重连额度耗尽时显示“重新连接”，原生不可用时选择按格式回退。`renderBackend` 只接受 `ganesh`（默认值）和 `graphite`；Kit 必须报告 GPU 后端，否则打开失败。引擎失败会关闭其通道；失败记录保留到 release，期间可通过 `info` 读取，重新附着则关闭记录并拒绝打开。

静态分页预览使用 `officePreview.pagePreview`：Host 将 Kit `render()` 与该文档的其他操作一同排队，通过一元 Remote 的二进制字段返回独立拥有的直通 alpha RGBA 字节，不经过帧转发。像素单边不超过 4096；请求和返回的字节都必须符合 `maxPagePreviewBytes`。已关闭或已失败的文档拒绝请求。文档绘制的 `generation` 是 `setContentWindow` 返回的已确认 viewport 版本；viewport 过期拒绝不会使引擎失效，Client 在最新 viewport 确认后重试；即使 `zoomSettleMs` 为零，重试也至少延迟 1 ms。`OfficeViewport.pixelSize / twipSize` 表示包含渲染 DPR 的渲染窗口物理像素/twip 比例，而不只是 CSS 像素比例。

Host 向每个文档视图下发 `overscanViewports`（默认 0.5）、`reanchorHysteresis`（0.25）、`zoomSettleMs`（120）和 `creditRetryLimit`（3）。前两者是 0–1 的比例，延迟是非负毫秒数，重试次数是正整数。每侧余量以可见视口为单位；滞回值表示重锚前预留的余量比例。Client 负责缩放稳定等待和纹理 credit 重试调度。Desktop 展示错误会使最新渲染窗口失效并重绘，不替换 mount。`maxDocumentBytes` 限制源文件字节数。`maxPagePreviewBytes` 设置编辑器输出上限，同时限制每次静态预览响应和单个文档的预览缓存。 Client 缩小余量以满足 Kit 单边 4096 像素的限制；可见区域本身仍超限时再降低渲染 DPR。在可用余量内滚动只更新 `setContentView`；重锚先等待上一次 paint 结束，再等待 `setContentWindow` 确认，用其返回的 generation 绘制。mount 自身的 viewport 更新和 viewport 过期回复会调度最新需求。分页预览 canvas 根据内容状态事件，仅为已提交的视频窗口与可见区域的交集挖洞，不使用逐帧回执。当前放映连接报告帧错误时，预览退出全屏并打开对应格式的回退视图。进入放映时卸载文档 mount，并在保留宽高比、留黑边的矩形中挂载 video；退出后恢复文档 mount。切换工作表或幻灯片时先卸载旧 mount，再创建新 generation。适应页面的幻灯片直接显示原生帧。原生窗口仅覆盖页面一部分或等待纹理 credit 时，才请求当前幻灯片的静态预览。预览随文档缓存，切回时即可显示。

每个已打开的文档还会收到来自现有 Host 配置的 `rendering.operationTimeoutMs`。Client 操作采用此超时，并受 128 个待处理请求的固定安全上限约束。设置到达前，首次打开由 Host 自身的打开截止时间约束。

Client 解析 Session 文件地址，并在打开文档时显式发送 `sessionId` 和 `path`。Host 根据该 Session 的工作区解析路径，并执行文件系统权限检查。`address` 用于标识视图，不用于选择 Host 文件。Host 将 Session 和解析后的文件绑定到地址及稳定的标签标识 `owner`，单独的 `revision` 字段为非负安全整数。打开同一修订时会重新连接原有引擎。打开不同修订时，即使渲染进程刚刚重启，也会先关闭旧引擎和通道，再重新加载文件。其他标签保留各自的引擎。文档连续 `orphanRetentionMs`（默认 60,000 毫秒）没有租约时，Host 会回收引擎和通道，包括打开后从未取得租约的文档。关闭标签会立即释放文档。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，Office 交互不添加模型上下文或提交 Agent 回合。

#### KV Cache effect

无。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

- 需要 Desktop、本地文件系统、匹配的 LibreOffice Kit 和可用的 GPU 后端。格式、动画和剪贴板保真度取决于 LibreOffice。
- 原生预览隐藏批注正文、标记和弹窗。
- 超大视口可能降低渲染 DPR。滚动中的原生内容与 DOM 对齐、同尺寸工作表/幻灯片切换及平台内存回收，需要真实 Desktop 验证；jsdom mount 测试不能证明合成器时序。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

Desktop 验收场景：打开 Word 并选择文本，将标签拖为浮窗，适应宽度，再收回较窄侧栏，然后终止引擎。标签必须切换到 PDF，不能停留在空白状态。在 PowerPoint 全屏放映期间和隐藏标签中重复操作：必须退出全屏，标签恢复显示时呈现回退视图。Excel 必须切换到浏览器表格。刷新后必须重新尝试原生渲染。另在延迟下一帧的情况下切换同尺寸工作表/幻灯片：旧 part 必须先消失，再显示新 generation，不能露出视图背后的内容。在 macOS 和 Windows 上确认停靠、浮窗和放映均使用 video。

</details>
