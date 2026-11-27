# Agent Note: 通用 Desktop 共享纹理 API 与共享的帧转发包

Status: implemented

[English](2026-10-15-desktop-shared-texture-api.md) | 中文

## Problem

原生 Office 预览需要把 LibreOffice 进程渲染的纹理不经像素拷贝地送达 Electron renderer，这要求一个 Electron 主进程侧的导入和一个 renderer 侧的 `sharedTexture` 消费者。“Office 预览编辑”bundle 的第一版设计允许 bundle 通过 `dsh.bundle.desktop` 声明 `main`、`preload` 和 `verify` 导出：Desktop 把 bundle 的模块导入主进程，为默认 session 的每一个 frame 注册其 preload，并用 bundle 自带的校验器校验其原生载荷。这种选择只能在应用启动时做出，因此启用或关闭该 bundle 必须重启 Desktop，而启动时的选择又必须穿透 `loadProfileDirectory`、`ProfileRuntimeResolution`、`DSH_DESKTOP_STARTUP_BUNDLES`、插件管理器（`restart-required`、`desktop-only`）、包清单类型和 Web 插件列表加以钉死。任何带有该声明的已安装包都能在主进程和 session 级 preload 中运行代码；而 Electron 的 `setSharedTextureReceiver` 是 document 级单例，两个这样的 bundle 会互相覆盖。

随后的修正把帧转发变成 Desktop 的固定能力：Electron 主进程运行原生接收器（先是从 dsh runtime 内的 LibreOffice Kit 接收端 SDK 加载，后来用拷贝进 `apps/desktop` 的 Kit 源码构建），校验 producer 元数据，并应答携带 viewport、generation 和信用的 `frame-forwarding` 控制消息。于是 `apps/desktop` 带着只有 Office 预览使用的协议，其 preload 暴露的是帧转发而不是纹理，位于 Electron Main 内的接收器不能使用 libuv 且需要与 Electron 兼容的构建，而每次协议变更都要先发 Desktop 版本，Kit 版本才能使用。把 Kit 的 C++ 拷进 Desktop 让同一个协议多出第二个自称的来源；从 Kit 加载则把 Desktop 接收器的每次变更绑死在 Kit 发版上。帧转发也不属于 Office：其他 Host 插件将来也会在各自的原生进程中渲染，因此接收器、传输和 Host 服务也不能归 Office 包所有，Kit 只是多个 producer 中的一个。

Electron 决定了 Desktop 必须持有什么。`sharedTexture.importSharedTexture` 只在主进程运行，且只接受该进程本地的句柄：macOS 上是 `IOSurfaceRef`，Windows 上是 NT `HANDLE`。`sharedTexture.subtle` 导出已导入的纹理供 renderer 导入，每个引用的释放回调在使用它的 GPU 工作完成后运行。托管的 `sendSharedTexture` 最多等待 renderer 确认 1000 ms；此后 Main 释放自己的引用，忙碌更久的 renderer 会导入一个已销毁的纹理并显示空帧。Electron 没有任何 API 能从 Chromium 之外的进程接收 GPU 句柄，Node 也不能接收 Mach 消息或复制 Win32 句柄。在 macOS 上，把外部 IOSurface 带进 Main 需要 Main 里的原生代码；在两个平台上，把 Host 本地句柄送往 Main 都需要 Host 里的原生代码。

Desktop 为这个消费者新增的任何东西，同一进程中的其他代码也能触达：Host 服务能被每个 Host 插件调用，preload 对象能被文档中的每段脚本调用。同一纹理接口的两个消费者会互相抢走对方的帧，在帧转发空闲时注册的消费者会接管该接口。Office 放映还通过 `dshDesktop.window.setFullscreen` 进入窗口全屏，这是 Desktop 的私有 API，Office 以鸭子类型读取它，Main 则靠自己的记录来恢复窗口状态；每个需要全屏的插件（例如游戏）都得要同样的窗口控制。

## Decision

Desktop 持有一个内部共享纹理 API，其唯一消费者是帧转发，包括在 Host 与 Electron Main 之间建立原生通道并跨通道传递 Host 本地句柄的跳转与 ingress addon；没有任何插件在 Electron 主进程或 session 级 preload 中运行代码。[`frame-forwarding`](../../../../packages/experimental/frame-forwarding/README.zh.md) 包为所有 Host 插件持有帧转发：`frameForwarding` Host 服务和 renderer 侧视图。

### Desktop：共享纹理

插件只看到帧转发。共享纹理服务定义位于 [`@deepseek-ai/dsh-shared-texture`](../../../../packages/shared-texture/shared-texture/README.zh.md)，采用独立的 Host 与 Client 编译面。其根入口（`.`）定义抽象 Host Cordis 服务 `SharedTexture`（`ctx.sharedTexture`），其 `claim()` 把 `capabilities`、`nativeSink` 和 `adapterLuid` 交给唯一的持有者，直到 `release()` 或发起认领的作用域被销毁；`./types` 入口定义不含 Cordis 依赖的 `SharedTextureClientExport`、`SharedTextureHostExport` 与 `SharedTextureLease`，供 Desktop preload 与 Client 插件共用；`./client` 入口是 Client 插件，把该桥接提供为 Client 侧的 `ctx.sharedTexture`，类型为 `SharedTextureClientExport`。web-app 挂载本包，其 Host 入口不做任何事。由于 Host 与 Client 编译面使用各自独立的 `tsconfig.{host,client}.json` 程序，Host 的 `Context` 声明不会进入 Client 程序。Desktop Main 从 Desktop Host 自己的 `types` 导出（[`apps/desktop-host/src/types.ts`](../../../../apps/desktop-host/src/types.ts)）导入两者经 Host 子进程通道交换的 `shared-texture` 控制消息（`capabilities` 和 `adapter-luid`）的类型；这是两者之间的私有协议，不是插件 API，hop addon 的接口留在加载它的服务旁边。两侧各自在运行时校验收到的每条消息（[Main 的通道](../../../../apps/desktop/src/shared-texture/channel.ts)、[Host 的服务](../../../../apps/desktop-host/src/shared-texture.ts)）。两个应用之间没有包依赖：Main 通过 TypeScript 项目引用编译这组导出。Electron Main 通过一个[入口](../../../../apps/desktop/src/shared-texture/main.ts)接入全部内容：它把 [shared-texture 通道](../../../../apps/desktop/src/shared-texture/channel.ts)挂到每个 Host 进程上，并提供窗口级和 Host 级清理；通道在 Main 的 presenter 看到请求之前校验每个控制请求，Host 进程生命周期不携带任何 shared-texture 路由。

- Desktop Host 的 [`sharedTexture` 服务](../../../../apps/desktop-host/src/shared-texture.ts)接收 Host 本地句柄，并在首次使用时加载 Main 在其能力中给出的跳转 addon（[`native/shared-texture/hop.cc`](../../../../apps/desktop/native/shared-texture/hop.cc)，仅依赖 Node-API 8）。macOS 和 Windows 上都由跳转向 Main 的 ingress 打开一条原生双向连接——macOS 上是一对 Mach 端口，Windows 上是双工消息命名管道并由 Main 把每帧的 Host 本地 NT 句柄复制进自己的进程——每帧的提交、送达回执和结算都走这条连接，Host 的 IPC 通道只承载 `capabilities` 和 `adapter-luid`。每条连接最多接纳 128 个未结算请求；连接丢失时所有未结算请求按 `invalidated` 结算，下一帧打开新连接。`nativeSink(timeoutMs)` 返回一个指向 `dsh_shared_texture_sink_v2`（[`native/shared-texture/shared-texture-sink.h`](../../../../apps/desktop/native/shared-texture/shared-texture-sink.h)）的不透明 `napi_external` 供同进程原生 addon 使用；按其他 ABI 版本构建的消费者会拒绝它。每帧携带句柄、尺寸、像素格式、元数据和只在 Host 本地生效的送达期限，不带请求标识。sink 归属当前连接：请求已离开 Host 时 `present` 返回 `DSH_SHARED_TEXTURE_PRESENT_OK`，只拒绝这一帧且 sink 仍可用时返回 `DSH_SHARED_TEXTURE_PRESENT_REJECTED`，连接已关闭或丢失时返回 `DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED`，之后每一帧也都如此，消费者随即取得新的 sink。取过 `nativeSink` 的认领结束时会关闭该连接并把未结算帧按 `invalidated` 结算。`adapterLuid(timeoutMs)` 在 Windows 以外直接返回 `null` 而不询问 Main，且从不打开原生连接；Windows 上 Main 从 Chromium 合成器导出一张纹理，经 ingress addon 读出其 adapter 的 LUID，并立即释放该纹理。Main 保留这个答案直到 Chromium 的 GPU 进程退出或 Host 停止，并发查询共用一次读取，失败的读取不保留。答案是小写十六进制的 `<HighPart>:<LowPart>`，与帧转发接收器表示 adapter 的文本一致；Chromium 没有导出 Direct3D 11 合成器纹理、DXGI 读不出其 adapter 或读取被清理取消时为 `null`。
- Main 的 ingress（[`native/shared-texture/ingress.cc`](../../../../apps/desktop/native/shared-texture/ingress.cc)）最多排队 32 帧等待 Main 的 JavaScript 线程，超出的帧当场按未保留引用拒绝，Host 可立即复用该纹理。对每一帧获准进入的帧，Main 的 [presenter](../../../../apps/desktop/src/shared-texture/presenter.ts) 导入句柄，经 Desktop 的 IPC 把 subtle 传输连同 Host 原样的 metadata 送到产品主 frame。Main 一直持有自己的导入，直到文档报告它已持有自己的引用，再在原生通道上回复 `delivered`；忙碌的 renderer 只会推迟该回复——即使送达超时也继续保留 Host 的槽位直至结算——而不会丢失纹理。Main 在原生通道上对每次获准的呈现只结算一次：自己的释放回调和文档的释放（文档在其释放回调中发出）都到达后回复 `released`；文档、renderer、GPU 进程或 GPU 释放同步先行消失或失败时回复 `invalidated`；不保留引用的失败回复表示 Main 未保留任何引用。Main 校验 Electron 限定的像素尺寸，解析 `metadata` 的 JSON 而不解释其中的字段。
- Main 的 `capabilities` 向 Desktop Host 报告其进程身份，Desktop Host 只把是否支持及原因交给其消费者；macOS 和 Windows 上还报告跳转 addon 路径，并为发出请求的 Host 打开一个仅依赖 Node-API 8 的原生 ingress。macOS 上（[`native/shared-texture/ingress-darwin.cc`](../../../../apps/desktop/native/shared-texture/ingress-darwin.cc)）ingress 是 Mach 接收端口：仅当消息的 audit trailer 指向 Main 所启动的 Host 进程时才接受，用 `IOSurfaceLookupFromMachPort` 解析携带的端口，交付 Main 本地的 `IOSurfaceRef` 并向 Host 的回复端口应答，同时丢弃其他进程的消息和超长消息而继续接收 Host 的消息。Windows 上（[`native/shared-texture/ingress-win32.cc`](../../../../apps/desktop/native/shared-texture/ingress-win32.cc)）ingress 是单实例双工消息命名管道：读取前先核对 `GetNamedPipeClientProcessId` 为该 Host 进程并断开任何其他客户端，连接期间持有该 Host 的 `PROCESS_DUP_HANDLE | SYNCHRONIZE` 句柄，把每帧的 NT `HANDLE` 从 Host 复制进 Main；同一 addon 还为 `adapter-luid` 经 DXGI 读取 Main 本地共享纹理的 adapter LUID。ingress 与该 Host 进程同寿命：窗口级清理保留它，因此 Host 每条连接只查询一次能力，之后每一帧都直接经原生通道呈现，无需额外的 IPC 往返。显式的能力查询总会到达 Main；Chromium 改用软件合成时（例如 GPU 进程多次崩溃后），Main 报告 `gpu-compositing-disabled`。Host 发来的协议版本不符或内容畸形的消息会以错误停止 ingress 并结束连接，下一次能力查询会重新打开它。

应用 preload 仅向产品主 frame 暴露 `dshDesktop.textures`：它导入每个传输，立即向 Main 报告结果，把 `{ frame, metadata, release }` 交付给唯一的文档消费者，没有消费者时立即释放到达的纹理。共享纹理 Client 插件把 `globalThis.dshDesktop?.textures` 提供为 Client 侧的 `ctx.sharedTexture`，因此其他 Client 插件从不读取 `globalThis.dshDesktop`。Desktop 不向文档提供窗口控制：要全屏显示视图的插件经帧转发使用文档的 Fullscreen API，Electron 为文档的全屏元素让窗口全屏，现有的状态同步让窗口外观随之调整。当 renderer 或 GPU 进程退出、跨文档导航提交或窗口关闭时，Main 取消待完成的 adapter 读取、拒绝清理期间到达的帧、把已发往文档的纹理结算为 `invalidated`，并开始新的文档代次；GPU 进程退出还会让 Main 忘掉合成器 adapter，只有在 Host 进程停止或失败时才关闭 ingress。Main 从不把未观察到的引用报告为已释放。被取消、被拦截和同文档导航保留文档的纹理，文档代次让跨越 ingress 替换期间发生的 reset 的能力查询失败。

### 信任模型

Main 只信任自己启动的 Host 进程。macOS ingress 丢弃经 audit 的发送方 PID 与 Host 不同的每条消息，并继续接收 Host 的消息；Windows ingress 在读取前核对 `GetNamedPipeClientProcessId`，断开任何其他客户端，并只从该 Host 进程复制句柄。producer 永远不与 Main 通信，Host 中只有 Desktop 的跳转接触 Host 到 Main 的通道。

安全审查面对两条进程边界。Host 到 Main 的边界属于 Desktop：Host 进程中的任何代码都能绕过 `sharedTexture` 服务直接向 Main 发送消息，因此 Main 的请求校验和 ingress 的 PID 检查作为 Desktop 的一部分审计，不随帧转发变化。producer 到 Host 的边界属于帧转发，记录在其[安全语义](../../../../packages/experimental/frame-forwarding/README.zh.md#security-semantics)中。插件 API 只有 `frameForwarding`；将 `sharedTexture` 保留给独占的帧转发消费者，只让它对普通插件不受支持，而不是不可达，因此它不是安全边界。两侧共享纹理接口同一时间都只接纳一个消费者，帧转发在加载期间占用二者：其 Host 插件从加载到卸载持有 Host 的 `sharedTexture` 认领，其 Client 从启动到销毁消费 Client 的 `ctx.sharedTexture`（没有打开的通道时也是如此）。因此其他消费者会立即失败，而不会在帧转发空闲时接管任一接口。认领随发起它的作用域结束，因此未释放就被卸载的持有者无法继续占用它。

### 帧转发包

`@deepseek-ai/dsh-frame-forwarding` 为任何 producer 使用其线上协议的 Host 插件持有帧转发。

- frame-forwarding 工作区将[接收器源码](../../../../packages/experimental/frame-forwarding/native/receiver.cc)与使用其协议的插件放在一起。Desktop 打包时直接从工作区为 macOS 和 Windows 的目标架构编译接收器，并预装二进制文件和构建清单。插件 npm 包不含接收器源码和二进制文件。Desktop 主进程根据当前安装位置或开发目录确定接收器的绝对路径，通过启动参数 `--frame-receiver-path` 传给 Host。Host 通过内部服务 `desktopFrameReceiver` 提供这个路径。插件首次使用时按自身要求校验构建清单中的协议版本和握手能力，再在 Host 进程中加载模块。每个通道的监听和与 producer 的握手都在 Host 进程中完成。
- Host 的 [forwarder](../../../../packages/experimental/frame-forwarding/src/host/forwarder.ts) 持有通道及其 producer 连接（[帧转发通道](2026-10-18-frame-forwarding-channels.zh.md)）、帧数与字节预算，以及 viewport 确认与重放。打开通道时，它询问 `sharedTexture.capabilities()`，取得 `sharedTexture.nativeSink()`，Windows 上还在创建接收器前通过 `sharedTexture.adapterLuid()` 读取 Chromium 的 adapter；每个通道都会询问，因为 Chromium 的 GPU 进程重启后 Desktop 会重新读取 adapter。它以 `attachSink` 把 sink 挂到该通道的接收器上，呈现期限最多 30000 ms，随后随连接、viewport 和可见性变化通过 `setDeliverable` 更新可交付状态。接收器 addon 内的 C++ Desktop 桥在产生帧的线程上校验 producer 元数据、按该可交付状态过滤帧，并以 `rx`、`connectionId`、`requestId`、`frameId`、`generation`、`revision`、`width` 和 `height` 作为元数据经 `dsh_shared_texture_sink_v2` 提交匹配的帧，稳态帧不经过 Host 的 JavaScript 事件循环。`on_settled` 回调在正常释放时直接归还帧信用；`invalidated` 时先停止接收器再释放交付，并通知 forwarder 以 `lost` 关闭通道。被拒绝的提交和失败的送达向 renderer 报告 `presentation-error`；以 `DSH_SHARED_TEXTURE_PRESENT_REJECTED` 之外的结果被拒的提交会解挂该 sink，被拒绝的单帧则保留 sink；未挂载 sink 时帧以 `frame` 事件到达 JavaScript，forwarder 立即归还信用，重新获取 `nativeSink` 并挂回各打开的通道。
- Host 插件是一个 Typert Remote 服务：消费者使用 `capabilities`、`channel`、`isOpen` 和 `close`；renderer 通过 `viewport` Remote 应用 viewport，并从 `events` 流跟随通道状态。Client 插件仅在 Client `ctx.sharedTexture` 可用时提供 renderer 侧的 `frameForwarding` 服务；`connect(rx)` 返回一个接收通道，它消费 `ctx.sharedTexture`，按元数据中的 `rx` 路由纹理，把每一帧借给消费者回调，并在回调结束后释放该帧。接收通道还持有文档的全屏元素（同一时间只有一个），并向其他通道报告遮挡（[帧转发通道](2026-10-18-frame-forwarding-channels.zh.md)）。通道随打开它的 Cordis 作用域一起关闭。
- 每个消费者 bundle 都以同一行 `frame-forwarding` 插入帧转发，且不带 config。Loader 对每个 id 只保留一行，因此同时启用的消费者共享同一个实例及其唯一的认领，关闭其中一个消费者时，该实例和其他消费者的通道继续运行；部署方用针对该 id 的 patch 调整其上限。

### 帧路径

```
LibreOffice (Kit producer holding the channel's TX credential)
   │  Packet protocol: hello / allocate / frame (+ handle) / release / message
   ▼
Host process — frame-forwarding receiver addon + C++ Desktop bridge (attachSink, setDeliverable)
   │  credits, budget, handoff, metadata check, deliverable filter → dsh_shared_texture_sink_v2.present
   ▼
Host process — Desktop shared-texture hop addon (≤ 128 unsettled; Host IPC: capabilities / adapter-luid only)
   │  macOS: Mach port pair (IOSurface port + reply port) ⇄ Main ingress
   │  Windows: duplex message named pipe (Host NT HANDLE; Main DuplicateHandle from Host) ⇄ Main ingress
   ▼
Electron Main — shared-texture ingress addon (delivery queue ≤ 32) + presenter → renderer frame
   │  document import result → delivered reply, Main drops its import; both GPU releases → released
   ▼
Native channel reply (released or invalidated) → hop reader → bridge on_settled returns credit (invalidated stops receiver first → channel lost)
```

## Alternatives considered

**保留 bundle 声明的 main、preload 和 verify 导出。** 这为一个消费者把主进程和 session 级 preload 的执行权交给每个已安装的 bundle，在多个 bundle 间重复一个单例 Electron API，并强制只能在启动时激活，连带穿透 app-boot、插件管理器、清单类型和 Web 插件列表的重启管线。评审中否决。

**把帧转发作为 Desktop 的固定能力留在 Electron Main。** 这是中间阶段的决定。它把只有一个插件使用的协议和绑定在 Electron 主进程的接收器留在 `apps/desktop`，把协议变更与 Desktop 发版耦合，并让 preload API 成为帧转发 API。它自身否决过的变体出于同样理由仍被否决：从 dsh runtime 内安装的 Kit 加载接收端 SDK 把每次接收器变更绑在 Kit 发版上；libuv 完成信号（`uv_async_t`）在 Node-API 的 ABI 保证之外，会迫使按 Electron 精确头文件构建。

**让 Office 包自带一个内含跳转的接收器 addon。** 帧转发服务于每个原生渲染的 Host 插件，而不只是 Office；跳转是 Desktop 共享纹理的机制，不是帧转发的。Office 自有的 addon 会被下一个消费者再拷一份，并让一个功能包成为 Mach 和 Win32 句柄传递的所有者。

**Electron 托管的 `sendSharedTexture` 和 `setSharedTextureReceiver`。** 它固定的 1000 ms 确认期限会在 renderer 主线程忙碌更久时让视图失败；即使在期限后继续持有 Main 的导入，也仍会在 renderer 的 GPU 工作完成前把 producer 的纹理归还。经真机卡顿测试后否决。

**通过扩展槽把插件的 addon 加载进 Electron Main。** 插件原生代码会在主进程中运行。在 Host 中加载它，让 Main 的原生代码固定为 Desktop 的 ingress addon。

**现在就把接收器作为预构建的 npm 平台包发布。** Desktop 打包已经在每个目标操作系统上带 C++ 工具链运行；在该包有第二个消费者之前，平台包会增加四个包、一条发布流程和 Windows 预构建 CI。推迟，而非否决。

**Desktop 不含原生代码，像素经 Host 拷贝。** 每帧要拷贝几十 MB，并失去原生预览赖以成立的共享纹理路径。它仍可作为小视口的兜底，不是本设计。

**让 producer 直接把 surface 发到 Main 的 ingress。** 这每帧省一条 Mach 消息，但要求 Main 鉴别一个不是它启动的进程，并要求消费者在启动 producer 之前拿到 Main 的端点。信任模型排除了它；重新考虑的条件是实测的跳转开销。

**全局 IOSurface 标识符（`IOSurfaceLookup`）。** 已被 Apple 弃用，且用户的任何进程都可读取。

**把接收器放在 `apps/desktop-host`。** Desktop Host 将因此背上一个协议的原生构建和服务；Desktop Host 提供共享纹理和预装接收器的位置，协议校验和 Node-API 绑定由插件维护。

**保留 `dshDesktop.window.setFullscreen`。** 它是按插件需求增设的 Desktop 窗口控制，以鸭子类型读取，并需要 Main 一侧的恢复记录。元素全屏以文档为范围，按 Escape 即可结束而无需插件代码，并让帧转发知道是哪个通道遮挡了其他通道。

**让每个消费者 bundle 各自插入一行帧转发。** 两个实例会争夺唯一的 `sharedTexture` 认领和唯一的 renderer 纹理订阅；第二个实例会报告原生渲染不可用，而第一个只服务自己的消费者。

**由 Desktop profile 自身插入帧转发。** 即使没有启用任何消费者，每个 Desktop 会话也会加载接收器并占用 Desktop 的接口，而不带 Desktop 专属行的 profile 也无法继续与 Web 共用。

**让 Office Host 插件自己在 Web 中隐藏 bundle。** 插件不需要 profile 检查：`frameForwarding` 不受支持时它报告不可用，Client 不注册 UI，现有的 PDF 和表格预览保持不变。

## Verification

Desktop 规格测试覆盖 [presenter](../../../../apps/desktop/tests/shared-texture-presenter.spec.ts)（每个 Host 一个 ingress 并在换 Host 时替换、软件合成检测、跳转 addon 路径与 ingress 端点、128 帧上限、不保留引用的 Electron 导入失败、renderer 导入结果（包括忙碌的 renderer、失败的导入和缺失的 GPU 同步 token）、先送达回复再结算回复的顺序、`reset` 在保留 ingress 的同时把已发往文档的帧结算为 `invalidated`、`dispose` 先放弃已发送的帧再关闭 ingress、ingress 失败与重开、adapter LUID 读取按 GPU 进程保留、并发查询共用、失败或被 GPU 进程退出抢先时不保留、Windows 以外返回 null，以及经通道应答的 Main 入口）、[preload 桥接](../../../../apps/desktop/tests/preload-shared-texture.spec.ts)（含导入结果报告，以及消费者和 GPU 用完之后的释放报告）、[已发送纹理的结算](../../../../apps/desktop/tests/shared-texture-transfer.spec.ts)、[shared-texture 通道](../../../../apps/desktop/tests/shared-texture-channel.spec.ts)只接受能力查询与有界 adapter 请求并携带 Host 身份路由控制、[通用 Host 进程通道](../../../../apps/desktop/tests/host-process.spec.ts)、[声明式原生包构建](../../../../apps/desktop/tests/native-package-builds.spec.ts)，以及 [shared-texture addon 校验器](../../../../apps/desktop/tests/shared-texture-runtime.spec.ts)。[Desktop 原生 e2e](../../../../apps/desktop/tests/shared-texture-native.e2e.ts) 在独立的 Main 与 Host 进程间经已构建的跳转与 ingress addon 从原生 `dsh_shared_texture_sink_v2` 线程交换真实纹理，覆盖每种回复类型、无法离开 Host 的呈现不发送即被拒、报告 sink ABI 版本 2 使按其他版本构建的消费者拒绝它、Main 的 JavaScript 线程阻塞时超出 32 帧投递队列的帧当场被拒并在恢复后继续处理、忽略端点上的其他进程并继续服务已注册的 Host、发送时发现 Main 已退出或 Main 无法投递其回复时结束连接、协议版本不符或请求畸形时停止 ingress、执行跳转送达期限的同时保留槽位直至 Main 结算、关闭或 Main 退出后的重连与单次结算，以及把共享 Direct3D 11 纹理的 adapter LUID 读成 Host addon 推导出的文本、其他句柄读不出 adapter。[构建产物 preload 的 e2e](../../../../apps/desktop/tests/preload.e2e.ts) 断言 `dshDesktop.textures` 只暴露 `onFrame`，且 `dshDesktop` 不暴露窗口控制。[Desktop Host 规格测试](../../../../apps/desktop-host/tests/shared-texture.spec.ts)覆盖唯一的认领、认领随发起它的作用域结束（包括像帧转发那样在该作用域的 effect 中发起的认领）、作用域销毁前的释放不影响下一个持有者的认领、跳转连接复用以及断连时把未结算帧置为 `invalidated` 并重连、取过 `nativeSink` 的认领结束时关闭该连接而未取过的认领正常结算、`adapterLuid` 不打开原生连接即返回 Main 的读取结果或 null、拒绝不是 LUID 的读取结果、报告 Desktop 给出的原因、超时并忽略迟到的回复、无关的通道流量，以及销毁时拒绝待完成的工作。帧转发规格测试覆盖 [forwarder](../../../../packages/experimental/frame-forwarding/tests/forwarder.host.spec.ts)（每个 Windows 通道都向 Desktop 读取 adapter LUID、每个通道都向 Desktop 取当前的 `nativeSink` 且并发请求合并、sink 期限上限 30000 ms、未挂载帧到达 JavaScript 时的刷新、在发出每个 viewport 之前更新可交付状态、呈现错误与失效处理、producer 连接与交接、viewport 重放、拆除）、[Host 服务](../../../../packages/experimental/frame-forwarding/tests/service.host.spec.ts)及其认领、由打开方作用域持有的通道和 Remote、[接收器加载器](../../../../packages/experimental/frame-forwarding/tests/native.host.spec.ts)及其构建记录检查、[Client 挂载](../../../../packages/experimental/frame-forwarding/tests/mount.client.spec.ts)、[wire 适配](../../../../packages/experimental/frame-forwarding/tests/wire.client.spec.ts)（含常驻的纹理订阅与全屏持有者）和[接收通道](../../../../packages/experimental/frame-forwarding/tests/rx.client.spec.ts)。[Desktop 桥原生 e2e](../../../../packages/experimental/frame-forwarding/tests/desktop-bridge-native.e2e.ts) 驱动真实 producer 穿过已构建接收器的 C++ sink 桥，覆盖元数据投射、正常释放和处于可交付状态之外时的信用归还、送达错误、被置为失效的帧先发出通知、再停止接收器及其连接后才释放、单帧被拒时保留 sink 而连接断开时解挂 sink 让后续帧到达 JavaScript、`present` 内同步触发的回调、拒绝其他 magic 或版本 1、3 的 sink 的 ABI 检查、接收器关闭并被垃圾回收后到达的结算，以及在 Desktop 的 addon 已构建时经 Desktop 的跳转 sink 送进 Desktop 的 ingress。[Kit 帧 e2e](../../../../packages/experimental/frame-forwarding/tests/kit-frames-native.e2e.ts) 在进程内原生 sink 扣住每一帧已呈现帧时，驱动已安装 Kit 的 LibreOffice producer 穿过已构建的接收器和 forwarder。[接收器原生 e2e](../../../../packages/experimental/frame-forwarding/tests/receiver-native.e2e.ts) 编译测试用 producer，跨 producer 进程、协议与能力不匹配以及共享预算收缩驱动它穿过已构建的接收器。NodeNext 声明检查拒绝公开声明 import 私有 workspace 包的发布包，从而让 Desktop 的类型不进入帧转发的发布 API。无 Session 格式或模型可见输入的变化。

## Consequences

插件可以在运行时安装或启用。由 Desktop 预装接收器，可以在没有 C++ 工具链的机器上启用 Office 预览；接收器的协议和原生修复随 Desktop 发版。各版本插件自行校验预装接收器，不兼容时报告不可用。稳态帧绕过 Host 的 JavaScript 事件循环；在 Host 与 Main 之间，每帧在 macOS 上开销为 Mach 消息，在 Windows 上开销为命名管道消息加 Main 执行的一次 `DuplicateHandle`，没有像素拷贝。纹理生命周期跨越三个进程：Main 自己持有并在 Electron 的 GPU 工作完成或 Host 拆除时关闭它从 Host 复制来的 Windows 句柄，Main 退出会连带结束 Host 和 producer。Windows 上由 Main 以 `PROCESS_DUP_HANDLE | SYNCHRONIZE` 打开自己启动的 Host，Host 从不打开 Main；打开失败会断开管道，`DuplicateHandle` 被拒绝会返回送达错误，而不是静默地什么都不呈现。

### Native producer SDK

原生 producer 接口仍在随 Office 集成调整。DSH 暂不向第三方发布 producer SDK：现在公开 C 头文件和静态库会让外部插件依赖仍可能变化的调用方式。待接口定型后再决定是否开放。LibreOffice Kit 通过自己的引擎接入。
