---
description: "面向 Host 插件的原生帧转发：可转交通道让 producer 进程不经像素拷贝地在 Desktop renderer 中呈现帧。"
kind: "package-reference"
---

# @deepseek-ai/dsh-frame-forwarding

[English](README.md) | 中文

## 概述

在自己的原生进程中渲染的 Host 插件，可以不经像素拷贝地把这些帧显示在 Desktop 文档中。`frameForwarding` Host 服务打开带可转交 producer 凭据的单 producer 通道，执行帧数与字节预算，并让 Desktop 呈现被接受的纹理；`frameForwarding` Client 服务把 renderer 连接到通道，并把每一帧借给消费者的绘制回调。LibreOffice Kit 是第一个 producer。

## 目录

- [使用此包](#use-this-package)
- [安全语义](#security-semantics)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Desktop 在 macOS 和 Windows 的安装包中预装帧接收器。预览 bundle 和通过 Plugin Manager 安装的帧转发插件都使用当前 Desktop 提供的接收器。

把本包作为不带 config 的 `frame-forwarding` 行与消费者插件一起插入。每个消费者 bundle 都插入这同一行，而 Loader 对每个 id 只保留一行，因此同时启用的消费者共享同一个实例：关闭其中一个消费者时，帧转发和其他消费者的通道继续运行。用针对 `frame-forwarding` 的 patch 调整其上限，它在所有 bundle 之后应用。消费者共享窗口的字节预算。在 Host 中用 `ctx.get('frameForwarding')` 读取服务，先探测 `capabilities()`，然后调用 `channel()` 得到 `{ tx, rx }`。把 `tx` 交给 producer 进程，例如作为子进程从父进程获得的凭据；任何持有副本的进程都可连接，不绑定任何 PID，`tx` 也从不进入 renderer、日志或诊断信息。把 `rx` 发给 renderer。每个通道最多服务一个 producer 连接：已有 producer 在线时，第二个候选以 `channel-busy` 被拒绝；producer 断开或退出后通道永久关闭（正常断开为 `closed`，传输或协议异常为 `failed`）。`isOpen(rx)` 报告通道是否仍处于打开状态，`close(rx)` 永久关闭通道。用 `ctx.get` 读取服务的 Cordis 作用域被销毁时（例如其插件重载），通道也随之关闭；Remote 方法的 `this.ctx` 是 Remote 网关的作用域，因此在 Remote 调用中打开通道的消费者须在自己的销毁中关闭它们。Desktop 无法再追踪它呈现过的某一帧时（例如 Chromium 的 GPU 进程退出后），通道以 `lost` 关闭；其所有者再次探测 `capabilities()`，并打开一个通道替代它。Chromium 改用软件合成后（例如 GPU 进程多次崩溃后），`capabilities()` 报告 `gpu-compositing-disabled`。无法呈现帧的 Host（例如 Desktop 之外的任何 Host）报告带原因的 `supported: false`，`channel()` 拒绝；原因只用于诊断，取值是开放集合，因此消费者只按 `supported` 分支。

在 Client 中用 `ctx.get('frameForwarding')` 读取服务，它只存在于能显示 Host 帧的文档中，即 Desktop 文档，因此消费者检测该服务，而不是检测 Desktop；再以 `connect(rx)` 获得该通道的 `FrameRx`。`setViewport` 发送严格递增版本的 viewport；若在通道仍处于 idle 时提交，Host 会保留并在 producer 建连后、交付其帧之前应用。Host 交付 generation 不超过通道最新 viewport 版本的帧，包括仍在途的更早 generation；该 viewport 不可见时不交付任何帧；文档挂载之外，接收通道释放其他版本的帧而不经消费。重新连接的接收通道（例如 renderer 重新加载后）从低于 Host 所保存版本的值开始计数：`mount()` 会改用更高的版本重试，`setViewport` 则以一个写明该版本的错误拒绝。在 producer 连接前发送的 viewport 会完成，并在连接后应用。producer 拒绝或未在 `requestTimeoutMs` 内确认的 viewport 以该错误拒绝，通道保持打开，下一个 viewport 照常发送。`ready(signal)` 在 producer 确认最新 viewport 后以连接 ID 完成。`closed` 在接收通道停止路由时以原因完成一次：被所有者、producer 正常断开或 `close()` 关闭时为 `closed`，另有 `lost` 和 `failed`。一个接收通道同一时间只有一种消费方式：

- **视频挂载。** 在具有尺寸的容器上调用 `mount(element, failure, options?)`，通过 `MediaStreamTrackGenerator` 把收到的帧送给 video 元素。`options.visible` 指定初始显式可见性（默认 `true`），挂载期间通过 `setVisible(visible)` 更新。新挂载复用一个仍然打开的通道时，会使用比 Host 保留的视口版本更高的版本。调用返回的清理函数即可卸载视频并停止轨道。卸载可见视图时会排队发送不可见视口，以便 producer 归还空闲 surface。
- **连续流。** `consume(present, failure)` 按最新优先呈现帧。`present` 运行期间只有最新到达的一帧在等待；更新的帧到达时，等待中的那一帧未经呈现即被释放。`failure` 接收在线 producer 的错误、通道关闭或 `present` 抛出的错误，流保持订阅。

`onEvent(listener)` 报告通道状态、视口、错误及内容提交。每次成功写入视频轨道都会发送包含 generation 的 content 事件，同一 generation 的重绘也会发送。连续清空内容只通知一次，新订阅者只会收到最近一次已提交的 generation。Chromium 实际显示这些像素的时间不可观测。

挂载会合并视口更新，并将物理尺寸、设备像素比和可见性（结合显式 `visible`、DOM 连接态、相交态、非零尺寸与 `document.visibilityState`）报告给 producer。文档隐藏时立即发送不可见视口。

挂载期间，`setContentView({ x, y, scale })` 设置元素左上角对应的内容坐标与每内容单位的 CSS 像素数；传入 `undefined` 恢复铺满模式。`setContentWindow({ x, y, width, height })` 把窗口绑定到新的 viewport 版本，完成时返回已确认的 viewport，其版本用于 paint generation；窗口不变时返回当前确认结果，不递增版本。必须等上一次 paint 完成后再调用，并等该 Promise 完成后才请求下一次 paint。帧转发只串行化 viewport 更新，不等待 paint：mount 已在途的更新先完成，未发送的窗口请求合并为最新窗口。数值非有限、坐标超出 ±2²⁴、宽高非正或大于 2²⁴、scale 不在 (0, 64] 时同步抛出 `TypeError`，不发送消息。两个 setter 在挂载之外均抛错；未完成的窗口请求在卸载时以 `cancelled` 拒绝。

`FrameRx.submittedWindow` 返回最后写入已挂载轨道的内容窗口，请求更新视口后仍保留该窗口。尚未提交图像、使用铺满模式或卸载后，其值为 `undefined`。视频按已提交帧所属的内容窗口和最新视图定位。调整大小时，等待下一帧期间文档画面保持原有宽高比。未指定内容映射时，帧铺满容器。切回曾从页面移除的标签页时，原视频轨道恢复播放。

每个消费者回调收到一个 `FrameForwardingFrame`，即 `{ image, metadata }`，借用期持续到回调返回或其 Promise 结束；随后帧转发关闭 `image`，把它占用的资源归还 Host。请在借用期内绘制、上传或复制 `image`。Desktop 共享纹理只有在 Desktop 报告 Electron 引用全部消失后才回到 producer，而 Electron 在使用该图像的 GPU 工作完成后才作此报告（[`getVideoFrame`](https://www.electronjs.org/docs/latest/api/structures/shared-texture-imported)）。保留 `image` 或其克隆会让它占用的资源一直处于使用中，直到它被关闭。`image` 的底层存储和像素 `format` 取决于 Host，因此读取像素只能通过 `drawImage`，或通过显式指定 `format` 的 `copyTo`。消费者不传队列大小，也不逐帧释放；`close()` 停止消费，并在所有借出的帧都释放后完成。帧元数据携带 `rx`、`connectionId`、`requestId`、`frameId`、`generation`、`revision`、`width` 和 `height`；`generation` 是 viewport 版本，`requestId` 由消费者选择、producer 回显。

配置只由 Host 插件读取：`maxFrames`（producer、Host、Desktop 与 renderer 合计持有的每通道帧数，默认 3，范围 3–16）、`maxBytes`（窗口内所有通道共享的分配预算：默认值 `auto` 取物理内存的一半且不低于 256 MiB；预算不超过物理内存，更大的字节数在第一个通道打开时降为物理内存，并在 Host 日志中警告）、`requestTimeoutMs`（adapter 探测、帧交付（含每次 Desktop 共享纹理交换）、producer 握手和 producer 确认的期限；一帧经 Desktop 呈现最多等待 30000 ms，这是 Desktop 的上限）、`maxPendingRequests`（每个连接等待确认的控制请求数）和 `maxQueuedEvents`（为尚未读取的 renderer 保留的通道事件数；通道的新状态替换其排队中的状态，超出上限时未读事件改为一份所有通道状态的快照，其中保留已拆除通道最新的至多 `maxQueuedEvents` 个未读关闭状态，未读的帧错误和更早的关闭状态被丢弃）。连续流 producer 若始终让 `maxFrames` 个 surface 中的一个不在途，就总有渲染目标，因此其状态无需等待信用即可推进，surface 归还时即发出其最新的完整帧。

插件从 Desktop Host 取得预装模块的绝对路径，首次使用时校验构建清单中的平台、协议版本和握手能力，再加载接收器。源码开发时运行 `pnpm --dir apps/desktop run build:native`。

原生 producer 接口目前仅供内部集成使用。[设计决策](../../../.agents/notes/implemented/architecture/2026-10-15-desktop-shared-texture-api.zh.md#native-producer-sdk)说明了暂缓发布 SDK 的原因。

**稳定性。** 本包是 experimental：Host 与 Client 服务的破坏性变更随其 semver 发布。包名不带 `experimental` 前缀，因此它移出实验分组时，引用它的 bundle patch 和 profile 保持有效；依赖隔离和晋升仍由实验性分类约束。线上协议为版本 2，接收器拒绝其他版本的 producer；同一版本内只通过增加双方都检查的握手能力来演进：接收器拒绝缺少它所要求能力的 producer，producer 拒绝不确认 producer 所依赖能力的接收器。

-----

<a id="security-semantics"></a>
## 安全语义

帧转发是插件使用的唯一原生渲染 API；以下是它的保证。

- **谁可以打开通道。** 任何 Host 插件都可以读取 `frameForwarding`。通道只向其 `tx` 的持有者授予权限；由插件决定哪些进程获得它，复制凭据不会吊销任何持有者。
- **producer 鉴别。** `channel()` 返回的凭据带 256 位随机密钥和不可猜测的 endpoint 名字：macOS 上是 Mach 服务，Windows 上是只允许接收器所属用户、拒绝远程客户端的命名管道。producer 的 `hello` 必须携带该密钥、协议版本 2 以及 `transferable-tx` 与 `producer-local-handles` 能力；接收器以恒定时间比较密钥，以 `invalid-credential` 拒绝不匹配者、以 `protocol-mismatch` 拒绝其他版本、以 `transferable-tx-required` 或 `producer-local-handles-required` 拒绝缺少相应能力的 producer，且只关闭该候选连接。每个物理连接都检查此后的每个包来自其握手时内核报告的发送方（Mach 审计 trailer、`GetNamedPipeClientProcessId`）并携带其连接 ID；该 PID 不授予任何权限。`close(rx)` 撤回 endpoint，凭据随即无法连接。
- **producer 句柄。** producer 只能指名自己拥有的对象。Windows 上每帧携带的是 producer 进程中的句柄值，接收器用 producer 连接时打开的访问权限从该进程复制它；值若不对应仍在运行的 producer 的任何句柄，该连接即结束，且不触碰任何 Host 句柄。ready 回显接收器接受的能力，因此 producer 拒绝会把其句柄值当作 Host 句柄读取的接收器。macOS 传递 Mach 端口权限，由内核在接收器中为其命名。
- **producer 隔离。** 每个通道最多服务一个 producer 连接且不会被抢占。producer 断开后通道永久关闭，帧与信用严格归属该连接；替换 producer 时由所有者打开新通道。
- **资源上限。** 每个通道最多有 `maxFrames` 个在途 surface，其中包括其 renderer 持有的帧；所有通道共享一个 `maxBytes` 分配预算，每个连接最多排队 `maxPendingRequests` 个控制请求。分配放不进剩余预算的 producer 会等待其他通道归还 surface；其通道保持打开，因此它的消费方保留已显示的内容，并在内容尚未到达处绘制占位。握手与确认等待在 `requestTimeoutMs` 结束。视图被隐藏或遮挡的 producer 把空闲 surface 归还共享预算：Kit 引擎在确认不可见的 viewport 后执行收缩。某一帧的 producer 信用只在 Desktop 报告其纹理的 Electron 引用全部消失后才归还；`invalidated` 结算先把通知排入队列，再停止接收器和这一帧所属的连接，然后才释放这一帧，因此 producer 不会重新得到该纹理的信用；forwarder 处理这条通知时以 `lost` 关闭通道。
- **renderer 输入。** 帧元数据由 producer 提供；Client 会校验它，并释放元数据无效或没有已连接接收通道的纹理。Host 会校验每个来自 renderer 的 viewport，并拒绝不高于通道当前版本的 viewport。renderer 从未发送的 generation 的帧不予呈现，无论 producer 确认了什么。
- **插件看不到什么。** 插件拿不到 Mach 端口、Win32 句柄传递、Electron，也拿不到 Desktop 内部的纹理接口，这些接口不支持插件使用。Host 插件从加载到卸载持有 Desktop Host `sharedTexture` 服务的唯一认领，Client 插件从启动到销毁消费 Client 的 `sharedTexture` 服务，因此二者的其他消费者都会立即失败。若其他消费者先取得 `sharedTexture` 的认领，帧转发会报告 `desktop-shared-texture-claimed`，直到它自身或 Desktop Host 的 `sharedTexture` 服务重新加载；对方释放认领时，帧转发不会接手。Host 到 Main 的边界是 Desktop 自己审计的边界，不随本包变化。

-----

<a id="understand-the-implementation"></a>
## 实现说明

工作区将[原生接收器](native/receiver.cc)和传输源码放在插件目录，由 Desktop 按目标架构编译。插件 npm 包不含原生源码和二进制文件。每个通道是一个稳定的监听端；每个 producer 连接拥有自己的 Mach 端口或管道实例、帧与分配、信用和中继状态，[通道记录](../../../.agents/notes/implemented/architecture/2026-10-18-frame-forwarding-channels.zh.md)持有交接的理由。producer 的 GPU 与 Chromium 的不同时，Windows 接收器把每一帧读回并上传到 Chromium 的 adapter，读回后即归还 producer 的信用；producer 标记为可替换的帧（`frame_replaceable`，由 `dsh_frame_forwarding_submit_latest` 设置）随后会替换尚未开始上传的已暂存可替换帧，而请求帧按顺序保持排队。

Windows 中继按分配保留跨 staging 槽使用的导入纹理，仅为同一 NT 对象且尺寸一致的帧复用。分配退役时先清除缓存导入再返还额度；未完成的 GPU 复制继续持有其源纹理直至完成。

Host 的 [forwarder](src/host/forwarder.ts) 在一个共享预算下创建接收器，为每个通道最多绑定一个 producer 连接（producer 断开即关闭通道），在通道空闲时保留初始 viewport 以便首次建连后应用，把 `sharedTexture.nativeSink` 返回的原生 sink 挂到每个接收器上，并持续更新每个接收器的呈现门控：最新 viewport 可见时，放行当前连接发来、generation 不超过该 viewport 版本的帧，包括更早的 generation。门控在每个 viewport 发出前就已更新：即使帧到达接收器时 Host 的 JavaScript 还没处理对应的确认，该帧也能通过。接收器在原生代码里经该 sink 以 Host 本地句柄和帧元数据呈现通过门控的每一帧，帧不经过 Host 的 JavaScript；门控之外或元数据无效的帧立即归还给 producer。交付只在 Desktop 结算该呈现后才归还给接收器；`invalidated` 结算会让接收器先停止再释放该帧，随后 forwarder 以 `lost` 关闭通道，呈现失败则作为 `presentation` 错误报告给 renderer 而不关闭通道。仅由 Desktop 拒绝的单帧（例如达到其呈现上限时）就是这样一种失败，接收器的 sink 保持挂载；sink 与 Main 的连接丢失时，接收器解除该 sink，把下一帧交给 forwarder，forwarder 把它归还给 producer，并为每个通道挂上新的 sink。Windows 上，每个通道都从 `sharedTexture.adapterLuid()` 取得 Chromium 合成器的 adapter，即 Desktop Main 从合成器导出的纹理读出、并在 Chromium 的 GPU 进程重启后重新读取的 LUID，因此每个通道都跟随 Chromium 当前的 adapter。Host 插件是一个 Typert Remote 服务：`viewport` 把 renderer 的 viewport 应用到通道。每次调用 `events(signal)` 都会替换上一次订阅，向当前 renderer 先发送所有通道状态的快照，再发送带递增序号的状态和标明来源的帧错误；超出 `maxQueuedEvents` 的未读事件改为一份新快照。

Client 半边从启动到销毁都消费 Client 的 `sharedTexture` 服务（由共享纹理 Client 插件从 Desktop preload 桥接提供，没有打开的通道时也是如此），按元数据中的 `rx` 把每个纹理路由到其接收通道并释放不带元数据的纹理，通过 `viewport` Remote 发送 viewport，并按序号应用通道状态，每份快照替换它已知的状态；新快照中缺失的通道报告为 `lost`，因为 renderer 无法得知它为何关闭。已关闭通道的状态保留到其消费者解除挂载；没有消费者的已关闭通道只保留最新的 64 个，以便迟到的消费者仍能得知其关闭。关闭接收通道时，Client 先移除它的帧与事件回调，再通知关闭监听器，因此监听器可以重新连接同一 `rx`。[接收通道](src/client/rx.ts)只持有正在绘制的帧和其后至多一帧最新的流帧，因此 Host 的每通道上限即可约束 renderer，无需自己的队列。

Desktop 内部的共享纹理服务、Mach ingress 以及把句柄带进 Electron Main 的跳转归 [Desktop 应用](../../../apps/desktop/README.zh.md)所有；本包持有它们唯一的认领，[设计记录](../../../.agents/notes/implemented/architecture/2026-10-15-desktop-shared-texture-api.zh.md)持有归属的理由。

-----

<a id="model-experience"></a>
## 模型体验

无：帧转发只在进程间搬运像素，不增加模型上下文或 Session 事件。

#### KV Cache effect

无。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

- 滚动或缩放时，视频播放与 CSS 位置可能在不同帧更新；提交 generation 不表示画面已经上屏。
- 仅支持 macOS 和 Windows Desktop；其他 Host 报告 `unsupported-platform` 或 `desktop-shared-texture-unavailable`。
- Desktop 在 renderer 导入纹理后才应答一次呈现，因此 renderer 主线程阻塞超过 `requestTimeoutMs`（默认 10 s）时该帧报告失败，且只在 Desktop 结算后才归还其 producer；更短的卡顿在 renderer 恢复时送达 producer 的最新帧。
- renderer 侧消费者的失败，Host 不会得知；消费者在对该接收通道的下一次操作被拒绝时才会发现。
- 保持在线但停止响应的 producer 会一直占用其通道，直到它退出或通道关闭；没有任何机制抢占它。
- 每个连接最多可有 256 条等待 Host JavaScript 处理的 producer 事件：消息、呈现错误和未交给 Desktop 的帧。超限时，接收器断开该 producer 并报告原因，Host forwarder 随即以 `failed` 关闭该通道。有一条 `rejected` 告警待处理时，接收器会合并后续拒绝告警。
- GPU 进程退出、renderer 退出、已提交的导航或窗口关闭会让画面上的纹理失效并以 `lost` 关闭其通道；消费者需打开新通道才能继续。
- 协议 1 的 producer 和接收器（例如 LibreOffice Kit 0.2.3 及更早的 SDK）会被拒绝；producer、接收器和引擎须一起升级。
- 在 Windows 上，接收器打开每个 producer 进程以复制其帧句柄，因此 producer 必须以 Host 的用户身份、在不高于 Host 的完整性级别下运行。接收器无法打开权限高于 Host 的 producer，会在握手时关闭该连接，且 Host 不记录诊断。
- Windows 上接收端只保留一个监听管道实例，把当前实例交给候选连接之后才打开下一个；因此 Host 用户的某个进程若每隔几毫秒就用错误凭据连接一次，可以让管道一直处于忙碌状态。producer 遇到忙碌的管道会一直重试到连接期限（默认 10 秒，或传给 `dsh_frame_forwarding_connect_with_options` 的超时）；只有管道名称连续 500 ms 不存在时才会提前放弃，而每次收到忙碌回复都会重新计时。因此这种风暴只有持续到期限才会让 producer 失败：报 `receiver unavailable`，传了超时则报 `connection cancelled or timed out`。再保留一个监听实例即可消除这段空档。
- 在 Windows 上，当 producer 的 GPU 与 Chromium 的不同时，producer 为不可见视图收缩时只归还源分配，不归还中继目标与暂存 surface：它们按最大分配尺寸继续占用显存和 `maxBytes` 份额，直到连接结束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

[原生 e2e](tests/receiver-native.e2e.ts) 编译测试用 producer，并用复制的凭据连接独立的 producer 进程，在崩溃后待扣住的帧释放即接管，拒绝测试用的其他协议版本、不具备可转交通道或不具备 producer-local handles 的 producer，并把被收缩的 producer 的空闲分配交给共享其预算的另一个通道。[Desktop 桥 e2e](tests/desktop-bridge-native.e2e.ts) 挂载实现 Desktop sink ABI 的 fixture sink：可交付状态之外的帧和 metadata 非法的帧不提交、直接归还信用；提交的帧以其标识作为 metadata，sink 释放后归还信用；invalidated 结算先停止通道再释放；Desktop 拒绝单帧时 sink 保持挂载，sink 失去连接时被解除，之后的帧交给 JavaScript；receiver 关闭后到达的结算也是安全的；Desktop 的 addon 已构建时，帧经 Desktop 的 hop sink 送进 Desktop 的 ingress 并遵循 Main 的结算。[Kit 帧 e2e](tests/kit-frames-native.e2e.ts) 在已安装 Kit 的 LibreOffice 进程中打开一份两页演示文稿，把其帧转给进程内的 Desktop 并读取 IOSurface 像素：按请求渲染的帧以其标识符到达、释放后归还信用；Desktop 扣住全部放映帧时放映状态仍继续推进，随后释放一帧即送达最新的幻灯片；正常替换和崩溃后的替代引擎都只在前一个引擎的帧释放后连接，并以重放的 viewport 渲染；已安装 Kit 的协议版本与本接收器不同时跳过该 e2e。原生测试均在 macOS 上构建 Desktop 原生模块 后用 `pnpm exec vitest run --config vitest.e2e.config.ts packages/experimental/frame-forwarding` 运行；Desktop 桥 e2e 也在 Windows 上运行。

</details>
