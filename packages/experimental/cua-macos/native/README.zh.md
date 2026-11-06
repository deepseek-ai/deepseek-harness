---
description: "macOS 原生辅助程序的请求协议、输入语义、共享服务和验证命令。"
kind: "package-reference"
---

# dsh-cua 原生辅助程序

[English](README.md) | 中文

## 摘要

该 JSON-lines 辅助程序支持 macOS 14 及以上，使用 Swift 6、AppKit、辅助功能、CoreGraphics 和 ScreenCaptureKit。程序改写了 MIT 许可的 Cua Driver 部分行为，不加载外部驱动。`upstream.json` 记录固定的上游版本、改写的 Swift 文件和本地模块；`LICENSE.cua-driver` 保留 MIT 声明。

## 目录

- [构建与服务](#build-and-service)
- [请求协议](#request-protocol)
- [观察与输入](#observation-and-input)
- [验证](#verification)

-----

<a id="build-and-service"></a>
## 构建与服务

运行 `pnpm --dir packages/experimental/cua-macos run build:native`，在 `native/bin/darwin-<arch>` 下生成带签名的 `DSH Computer Use.app`，`current.json` 选择完整的内容摘要目录。默认使用临时签名；正式打包可传入 `--identity` 指定 Developer ID，并由发布流程完成公证。Host 运行应用内的 `--ensure-shared` 入口，经 LaunchServices 后台启动服务。最后一条连接完成清理后，服务退出。 helper 嵌套在另一个 `.app` 内时，启动器先把完整的已签名应用复制到 `~/Library/Application Support/DeepSeek Harness/Computer Use/<runtime-key>/`，再启动它。每个不可变目录都校验可执行文件哈希和应用签名，旧目录保留给仍在运行的安装版本使用，使两项 macOS 权限都归属于 helper。校验失败会中止启动；删除报错中指定的缓存目录后再重试。

源码检出以 `--variant dev` 构建，应用包为 `DSH Computer Use Dev.app`，Bundle ID 为 `com.deepseek.harness.computer-use.dev`。开发版和正式版默认临时签名。临时签名的指定要求包含代码哈希，二进制变化后可能需要重新授权。

源码 provider 的 `sourceSigning: { identity, keychain }` 选择已有证书及其钥匙串绝对路径。构建 CLI 使用 `--identity <证书名称或 SHA-1 指纹>` 和 `--keychain <绝对路径>`；正式打包也可省略 `--keychain`，使用用户搜索列表。构建不生成、解锁或移除签名身份；所选证书不可用时签名失败。

仓库的[开发者签名 skill](../../../../.agents/skills/dsh-cua-macos-signing/SKILL.md)负责 Agent 操作流程：在 `~/.cua-macos-keys/` 生成独立身份，将指向它的配置写入 DSH home，并按需解锁或移除。私钥和密码由开发者单独维护，删除 DSH home 不会删除它们。同一用户的进程可以读取保存的密码并使用该身份签名。

使用相同证书的构建共用包含 Bundle ID 和证书的指定要求。首次授权仍需在系统设置中完成；签名要求相同不代替授权后重建、跨 worktree 的实际权限验证。

证书签名包含签名时间。开发构建在 `sources/` 中记录每个未签名应用与证书指纹对应的目录，内容不变时复用该目录。临时签名使用独立记录。显式传入证书名称时会重新签名，因为续期可能改变名称对应的证书。

`native/.build/prepared/<arch>` 和 `native/bin/darwin-<arch>` 中的各代应用不会自动清理。正式打包时使用全新的 `--output-directory`，或确认没有客户端使用后清理打包输出再构建，避免旧应用进入 tarball。安全签名时间戳可能让相同源码生成不同代应用。

手动工作流 **Package CUA helper · macOS** 的[配置](../../../../.github/workflows/cua-helper-package.yml)在 `dsh-mac-package-trial` 构建两种架构。手动启动时，在 **Use workflow from** 中选择可信的分支或 tag，再选择机器 `preset`。checkout 使用本次 Actions 运行记录的提交；由发布工作流调用时使用调用方本次运行的提交。手动运行始终构建新产物。发布复用使用 Node 原生 `fetch` 和工作流提供的 `GH_TOKEN` 查询 GitHub API。签名凭据沿用[macOS 打包配置](../../../../apps/desktop/packaging/README.zh.md#macos-actions)。打包无需 macOS 桌面登录或 Rosetta。在仓库根目录运行 `node --import tsx/esm scripts/cua-helper/package.ts --out <new-directory>` 可执行相同准备。完整应用签名、公证和贴票后才确定最终内容摘要，再从解包后的 `cua-helper.tgz` 验证架构、签名、票据、Gatekeeper 和文件完整性。打包不启动 helper。在已登录的桌面会话中单独运行 `python3 scripts/cua-helper/smoke.py <helper-executable>` 检查能力、helper 身份和退出清理；Apple Silicon 上执行 x64 版本需要 Rosetta。该检查不申请权限或观察应用。命令失败、超时或启动回复无法解析时，会输出捕获的 stdout 和 stderr；无效编码只在诊断文本中替换，协议解析仍严格校验。打包成功不代表运行验收通过。 helper 打包保留独立的[诊断记录](../../../../apps/desktop/packaging/README.zh.md#macos-release-signing)，包括桌面安装包开始构建前发生的失败。

工作流保留 `cua-helper.tgz` 和 `cua-helper.json`。清单记录原始构建的产品版本、commit、Team ID、两份应用摘要、源码摘要和构建摘要。[Release publish](../../../../.github/workflows/release-publish.yml)始终调用该工作流，再按返回的 run ID 和 artifact ID 下载所选产物，生成 provider 的 npm 包。准备步骤校验当前 helper 的源码摘要、选定的构建摘要、两种架构、应用目录、文件字节和执行权限。npm 发布在写入注册表前重新检查实际 provider tarball。无关 commit 或产品版本变化时，复用保留原始清单和已签名字节。普通 PR 发布检查不使用签名凭据。

**Release publish (dsh)** 接受可选的 `cua_run_id`：填写构建运行页面 URL 中 `/actions/runs/` 后的数字，不填 job ID。发布工作流开启 `reuse`，并通过 helper 的 `workflow_call` 参数传入这个选择；这两个复用参数均不出现在 helper 的手动表单中。`cua_run_id` 留空时自动查找，查询这两个工作流最近 14 天创建且已结束的运行，选择未过期的匹配产物。选择在 Mac 上执行，早于 pnpm 准备和依赖安装。命中时跳过安装、编译、签名和公证，自动查找未命中时重新构建。手动指定 run ID 时先固定最新 attempt，再选取该 run 历史中最后一次实际执行的 helper job。仅重跑 pack/publish 时仍可使用原 helper 产物；若更新的 helper 执行失败，则不复用更早的成功产物。产物缺失或过期、输入不匹配时直接失败，不改选其他运行。后续 npm 失败不影响成功的 helper job。GitHub API 读取失败会停止选择。运行摘要链接实际构建者；只复用产物的运行不重新上传副本，手动选择时填写摘要所链接的构建 run ID。产物保留 14 天。选择后过期或被删除会使下载失败，不自动改选或构建不同字节；按下方重试说明处理。

[源码摘要](../../../../scripts/cua-helper/build-inputs.ts)覆盖受跟踪的 helper 源码、资源、CUA/Desktop 打包脚本、两份工作流、包与编译器配置、锁定依赖、pnpm 配置和补丁；受跟踪的 `node_modules` 文件也参与比较。包清单只排除版本字段，其余字段保留。构建摘要还包含 preset、Node/Swift/Clang/Python 版本、macOS SDK build、签名身份、Team ID 和证书容器摘要，不包含密码。选择时使用生产运行的 GitHub `head_sha`，独立比较对应 Git 树与包清单 blob 和当前 checkout 的路径、字节及执行权限，不能仅凭产物自报摘要认定源码一致。helper 依赖安装禁用生命周期脚本和 pnpmfile hooks。输入缺失或 GitHub 证据无法读取时失败。没有匹配记录的旧产物需要重新构建。选择仍需等待 Mac runner 并检出代码，消费产物的 pack job 再校验下载的应用字节。

npm 发布在上传部分包后失败时，只重跑 **Publish to npm**，复用保留期内的 `dsh-npm-tarballs`（7 天）。该 job 上传原 tarball，跳过已发布且字节相同的包。此次重试不要重跑全部 job。若必须新建运行，以同一 commit 和版本重新打包，填写 pack 摘要中的原始构建 `cua_run_id`。原产物不可用或任何重新打包的内容不同时，应停止发布；不能用不同内容替换已有 npm 版本。

启动错误通过当前用户专用、每次启动独立的错误文件和 launcher 的 JSON 错误帧保留错误码与消息。等待启动锁和就绪状态共用一个期限，系统启动应用的耗时计入该预算。就绪记录必须指向本次启动的 PID。新实例启动失败后，launcher 强制终止并等待其退出，再报告失败；清理另有与启动超时等长的期限。连接已有服务失败时不会终止该服务。

应用图标通过 `pnpm --dir packages/experimental/cua-macos run build:icon` 从 [Computer Use 图形](../../cua-bundle/icon.svg)生成。原生图标在图形下添加不透明的白色圆角底板，外侧四角保持透明。系统授权提示和 DSH 权限页使用这个应用图标。

共享服务在 `/tmp/dsh-cua-<uid>` 下使用仅所有者可访问的 Unix socket，以可执行文件的 SHA-256 区分实例。版本锁选出一个进程，另一个真实可执行路径锁排除同一路径的不同构建。首帧为协议版本 1 的 `hello`，包含运行时标识以及该连接的字节、AX、操作、截图、事件间隔和清理限制。`ready` 返回已核实的运行时标识、PID 和实例 ID。每条连接拥有独立的 AXWorker。stdin/stdout 入口是该服务的诊断代理。

AppKit 在主事件循环上运行。阻塞式 socket 接收与握手使用后台队列，服务回调明确声明 `@MainActor @Sendable` 隔离，并弱引用服务对象。关闭时会释放已接收的连接，包括尚未完成握手的连接。阻塞式 AX 和输入使用每条连接的串行 actor，所有连接共享用于完整桌面操作的 FIFO。socket 写出不占用操作槽位。请求取消会等待原生工作停止，不取消连接的生命期控制器。截图超时只结束该请求。未完成的系统捕获保留唯一捕获槽位，直至真实回调到达；期间新截图返回 CAPTURE_BUSY，AX 和输入仍可用。只有无法停止的操作或清理才可能使共享进程失效。代理接受 `--max-request-bytes`、`--max-response-bytes`、`--ax-timeout-ms`、`--timeout-ms`、`--screenshot-timeout-ms`、`--shutdown-grace-ms` 和 `--text-event-interval-ms`；Host 在 hello 中设置相同限制。AX 超时约束单次系统调用。取消可能发生在部分输入之后，结果不确定的输入不自动重放。


-----

<a id="request-protocol"></a>
## 请求协议

操作帧为 `{ "id": "opaque request id", "method": "method name", "params": {} }`。对应回复只包含 `result` 或 `error: {code, message}` 中的一项；无效信封返回 `INVALID_REQUEST`，ID 为 null。每条连接同时最多发送一个操作。`{ "type": "cancel", "id": "request id" }` 取消该请求，迟到的取消不会产生额外回复。`protocol.schema.json` 定义操作字段。

截图诊断通过原始连接发送 `type: "diagnostic"` 帧。记录包含 requestId、stage、从接收开始计算的 elapsedMs 和可选的 errorCode，不含窗口标题、AX 文本或图片字节。stdin/stdout 代理在 stderr 上以 `[cua-screenshot]` 前缀转发诊断，操作回复仍写入 stdout。Host 保留有上限的诊断缓冲区，并将其附在截图失败中。

成功的 `activate` 返回 `dispatched` 和 `foregroundChanged`。观察到前台进程或窗口变化时，后者为 true，两者均确认相同时为 false，证据不足时为 null。原生结果还包含 `foreground`，记录请求 ID、目标 PID、是否请求激活以及操作前后的进程和窗口。这些采样可能与其他桌面操作交错。

| 方法 | 结果 |
| --- | --- |
| `getCapabilities` | `{permissions: {accessibility, screenRecording}, sessionLocked}`。权限值是布尔型预检结果，不打开系统提示。TypeScript provider 在暴露结果前合并其静态启动字段（`platform`、`methods`、`appLevelAccessibility`、`keyboard`、`browser`、`coordinateSpace`）。 |
| `listApps` | 运行中的普通应用数组，元素为 `{pid, name, bundleId}`。 |
| `findApps` | 从标准应用目录或绝对应用路径返回已安装匹配项 `{id, displayName, path, isRunning, pid?}`；发现过程不启动应用。 |
| `getApp` | 运行中的选择返回 `{appHandle, pid, name, bundleId?, running: true, authorization}`。未运行的选择返回 `{appHandle, name, bundleId?, running: false, authorization}`，其中没有 `pid`，并等待 Host 授权。名称歧义会失败。 |
| `launchApp` | 授权后的 Host 专用续接操作；不请求激活，等待应用启动完成后将句柄绑定到已核实的进程身份。 |
| `listWindows` | 应用所属普通窗口，包含 `{windowId, appName, title, bounds, isOnScreen, onCurrentSpace}`。Space 归属可为 null。 |
| `getState` | `{appHandle, windowId, focusedWindowId, snapshotId, tree, elements, windows, truncated}`。应用级观察的 `windowId` 为 null。元素包含不透明字符串 `elementId`、role、title、value、description、identifier、bounds、actions 和 enabled 状态。元素边界为 null 或屏幕 point 单位的 [x, y, width, height]，窗口输入使用局部 point。这些结构化元素诊断供原生检查保留，模型工具投影会移除它们。不可用的可选描述属性为 null，无法取得的动作列表为空；权限、通信和窗口发现失败仍会拒绝观察。 |
| `listActions` | 一个元素由 provider 定义的动作名数组；元素可以不声明任何动作。 |
| `show` | `{dispatched: boolean, windowId, foregroundChanged}` 记录恢复分派。未选中窗口时 `windowId` 为 null；无法取得采样观察时 `foregroundChanged` 为 null。 |
| `invoke`, `performAction`, `mouseMove`, `click`, `setValue`, `selectText`, `typeText`, `paste`, `pressKey`, `scroll`, `drag` | `{dispatched: boolean}` 记录原生分派；`invoke` 在没有可用的默认动作时返回 false。`mouseMove` 还报告 `hoverRoute` 和 `systemPointerMoved`。需要读取新状态以核实预期的应用变化。 |
| `screenshot` | `{mimeType: "image/png", data, pixelWidth, pixelHeight, bounds, coordinateSpace: "window-points", windowId}`。Retina 显示器上 PNG 像素尺寸可能不同于窗口 point 尺寸。 |

每个面向应用的操作都要求使用同一 helper 的 `getApp` 返回的 `appHandle`。helper 固定 PID 和内核进程启动时间，进程退出或 PID 被复用后使句柄及其全部快照失效。再次调用 `getApp` 可取得替代进程，不会重新激活旧句柄。随机的 helper 命名空间防止已终止 helper 的句柄与替代实例重合。重复获取同一存活进程会共享句柄。启动后检查失败会使待启动句柄失效，并保留原错误；已经启动的进程不会被终止，launchApp 也不能复用失败的句柄。

稳定错误码包括 `INVALID_REQUEST`（信封无效）、`INVALID_ARGUMENT`（参数无效）、`UNSUPPORTED`（操作未知）、`APP_UNAVAILABLE`、`APP_PATH_UNAVAILABLE`、`PROCESS_INSPECTION_FAILED`、`AMBIGUOUS_APP`、`STALE_APP`、`STALE_SNAPSHOT`、`WINDOW_UNAVAILABLE`、`WINDOW_CHANGED`、`PERMISSION_DENIED`、`FOREGROUND_REQUIRED`（悬停目标不是未被遮挡的前台窗口）、`PANEL_NOT_READY`（输入前系统面板接收方尚不可用）及 `NATIVE_ERROR`（其余操作系统失败）。错误不保证已分派的部分输入被回滚，Host 不得自动重试输入。

应用选择向 Host 返回授权记录：区分大小写的 Bundle ID 加上 `macos:bundle-id:` 前缀后计算的 SHA-256 摘要、显示名称、可选的可执行路径和可持久化标记。相同标识的所有安装副本共用授权，包括未签名和临时签名的应用。缺少非空 Bundle ID 时，运行中和未启动应用都对 `macos:executable-path:` 与解析符号链接后的可执行路径计算 SHA-256，仍可保存长期授权。进程路径查询失败时，运行中的有效 Bundle ID 仍可用于授权，记录省略 executablePath；路径可取得时仍须与所选目标一致。两种身份均不可用时，在执行目标操作前返回 APP_PATH_UNAVAILABLE，保留路径查询原因和 errno。PROCESS_INSPECTION_FAILED 表示无法验证进程实例，只有进程检查返回 ESRCH 时才报告进程不存在；两种失败都不触发自动重试。进程号和启动时间只校验存活句柄，不进入已保存身份。Host 从模型结果中移除此记录，并在启动、观察和输入前取得用户许可。此管道协议用于可信 Host 传输，无法隔离另一个已获授权的 shell 进程。

协议声明从[共享协议](../../cua/src/protocol.ts)生成。在仓库根目录运行 `pnpm exec tsx packages/experimental/cua-macos/native/generate-protocol.ts`，包测试检查生成的 JSON 和 Swift 字段/枚举表。模型参数不包含 Host 资源上限和私有启动续接操作。


-----

<a id="observation-and-input"></a>
## 观察与输入

`getState` 可将 AX 遍历限定到应用所属窗口或嵌套 sheet 的 `windowId`。新的刷新或失败的刷新使同一应用/窗口范围的旧快照失效，其他窗口范围仍可使用。应用所属 CG 窗口没有匹配 AX 界面时，getState 返回空 tree/elements、truncated 为 false 的新快照，仍可截图和坐标输入。遍历后重新检查进程生命期、窗口归属、会话未锁定及辅助功能权限。窗口发现中的 APIDisabled 和通信错误仍会失败；不支持或缺失的可选 AX 属性可以产生空观察。不存在或属于其他应用的窗口不会返回空成功结果。遍历中 AX 元素失效会以 `STALE_SNAPSHOT` 拒绝整次读取，不发布部分树。应用变化后可以重新观察，但不重复输入。原始元素目标要求 `appHandle`、`snapshotId` 和不透明字符串 `elementId`；坐标动作要求 `windowId`，并可携带属于该窗口或应用级观察的快照 ID。原生引用不跨 JSON 传递。刷新窗口列表会释放已关闭窗口的快照。进程身份、快照代次和窗口归属检查不会锁住桌面，用户或应用仍可同时改变状态。

未指定 holdMs 的元素点击优先使用声明的 AX 动作，否则通过鼠标事件发送。坐标点击、滚动和拖动核实窗口归属和边界后，使用后台 PID/窗口定向输入。事件优先使用 SkyLight，不可用时使用公开的 PID 定向 API；已发送的事件不通过另一 API 重发。坐标是整个窗口左上角起算的 macOS point，包含标题栏。`deltaLinesY` 为正时显示上方内容，为负时显示下方内容；`deltaLinesX` 为正时显示左侧内容，为负时显示右侧内容。每个轴接受 -10 到 10 的整数，至少一个轴非零。helper 直接发送按行计量的滚轮事件。点击和拖动支持左、右、中键及 command/control/option/shift/fn 修饰键，只有左键支持双击。带修饰键的元素点击使用鼠标输入。拖动在一个窗口中完成一次按下、移动、抬起，调用方显式提供 durationMs（1..5000）和 steps（1..240）。移动延迟按小数精度分配到各段，按下和抬起的固定等待及调度延迟另计。不存在隐式改用全局桌面输入的后备路径。

`click.holdMs` 是可选的每次按住时长，单位为毫秒，接受非负整数；0 表示不额外等待。每个连接通过 `maxClickHoldMs` 限制显式按住时长。诊断 helper 的 `--max-click-hold-ms` 选项默认 5000。指定后使用元素中心或给定坐标发送鼠标事件，跳过 AX 动作。省略时保留普通点击时长。整个手势占用请求调度槽位；取消、超时和断开连接会中断等待，在释放槽位前发送对应的松开事件。已接收的事件仍然生效，进程被强制终止时无法保证清理。

截图和鼠标输入在精确窗口的 AX 边界查询前后读取 CG 边界，查询期间移动会返回 WINDOW_CHANGED。有效的 AX/CG 边界向外取整后必须一致；已知不一致会在移动、预备事件或按键发送前返回 WINDOW_CHANGED。helper 保留两个坐标来源，不用 AX 几何替换 CG 几何。缺失或无效的 AX 几何仍表示未知，AX 通信、权限和无效元素错误继续传递。无辅助功能权限的截图保留 CG/SCK 检查。声明的 AX 动作不经过鼠标预检，AX 动作失败也不改用鼠标输入。这些读取不会锁住窗口以阻止后续移动，几何检查不激活或抬起窗口。

`typeText` 和 `pressKey` 面向所选进程当前获得焦点的控件，不指定窗口。`pressKey` 在按住所列 `modifiers` 时按下并释放一个键，先向 PID 发送修饰键变化，再发送主键，并逆序释放修饰键，不使用全局 HID 队列。按键名由平台定义；KP_0 和 KP_Enter 等数字键盘名称保留物理键码。后台鼠标操作可能改变键盘焦点。文本逐个 Unicode 字符输入，不使用剪贴板。LF、CR 和 CRLF 发送一次 Return，制表符发送 Tab。应用保留缩进和焦点导航等正常编辑行为。`typeText` 的每次按下和抬起后等待配置的文本事件间隔；`pressKey` 使用自己的按下与释放节奏，分派完成不证明应用已消费全部事件。取消可能中断部分文本或手势，无法撤销已接收事件。很长的文本可能超过 Host 操作期限。继续输入前应核实应用状态。

所选 helper 应用需要 macOS 辅助功能权限以读取 AX 和输入，需要屏幕录制权限以截图。能力预检和权限错误不授予权限。截图会拒绝在读取图片期间移动或缩放的窗口。无法确认归属的系统面板及仅后台辅助类型的应用不可选择。

仅供 Host 使用的权限操作为 `permissionStatus {}`、`requestPermission` 和 `openPermissionSettings {permission}`，其中 permission 为 `accessibility` 或 `screenRecording`。请求携带本地化的 `instruction`、`backLabel`、`finderLabel`、`unavailableMessage`、`settingsMessage`，以及 100–2147483647 的整数 `pollIntervalMs`。原生引导将 `{application}` 替换为自身应用名。状态返回权限观测、进程诊断和 `launchApplication` 信息。这些操作不出现在模型工具及 `getCapabilities.methods` 中。helper 动态解析 `responsibility_get_pid_responsible_for_pid`，函数签名与 [Chromium](https://chromium.googlesource.com/chromium/src/+/refs/tags/134.0.6998.28/base/process/process_info_mac.mm) 一致，在报告就绪前记录责任 bundle，无法获取时使用自身 bundle。父进程路径不决定授权归属。

观察通过 `AXUIElementCopyMultipleAttributeValues` 读取每个非布局节点的描述属性和子节点。逐属性错误保留单独读取的规则；不支持批量 API 时使用单独读取。值只在本次观察期间保留，输入读取即时属性。应用状态可能在节点之间变化，批量读取不使整棵树具备原子性。

系统文件面板的键盘路由通过所选应用的 AX 焦点 sheet 解析远端接收方。只接受 Apple 的 Open and Save Panel Service，且其焦点祖先链仍须包含已识别的远端窗口。AXWindow 不可用时，元素鼠标后备路径沿 AX 父节点解析应用所属窗口或 sheet。普通点击保持 AX 动作优先，可视点击标记不需要系统鼠标移动。

键盘修饰键名称是普通字符串。共享对象 API 原样传递名称；macOS helper 接受 `command`/`cmd`、`shift`、`option`/`alt`、`control`/`ctrl` 和 `fn`，未知名称返回 `INVALID_ARGUMENT`。它不解析组合键字符串。

读取树或枚举动作时，某个元素的动作名查询返回一般性 AX 失败，helper 将其视为缺少动作元数据。枚举时跳过无法确认可写性的属性。`invoke` 需要成功查询元素动作才能报告没有默认动作。`setValue` 仅在元素确认 `AXValue` 可写时尝试写入。

`selectText` 要求新近元素快照和可写 AXSelectedTextRange。它匹配唯一的字面文本，可用紧邻的 prefix/suffix 缩小范围，然后选中文本或将光标放在前后。匹配和返回范围采用 UTF-16 偏移。歧义或缺失文本会失败，helper 不改写内容，并重新核实值和选区。AX 文本包含可用的可写性、禁用状态、选中状态和选区信息；AXAccess 持有元素 ID 和原生引用，AXTextFormatter 渲染已观察的值。

`paste` 提供一种纯文本或 HTML 剪贴板格式，调用应用已启用的标准 Paste 菜单命令，并等待剪贴板数据请求。随后仅在所有权标记和修改计数仍匹配时恢复原有格式。Host 通过文件锁串行化不同 helper 的粘贴。maxClipboardBytes 同时限制输入和保留内容，不支持的菜单和过大的数据在分派前失败。后续复制会被保留。取消会尽可能恢复仍持有的剪贴板数据，强制结束不保证恢复，数据请求也不证明目标已完成编辑。 分派完成后，`pasteReadTimeoutMs` 限制等待剪贴板读取的时间。到期返回 `PASTE_NOT_CONSUMED`，关闭延迟数据提供方，并仅在仍持有剪贴板时恢复原内容。该失败不能证明应用以后不会处理已排队的 Paste 命令；决定是否重试前先检查目标内容。

`mouseMove` 接受已观察的元素 ID 或窗口内坐标，不按下鼠标按钮，也可用于禁用控件。调用结束、AX 读取和截图都不恢复原位置，后续 mouseMove 调用可进入新出现的内容。点击只在目标位置发送按键事件，不先在窗口外点击。单次请求串行执行，不在调用之间保留应用。其他输入或应用变化可能中断交互。

`mouseMove` 优先查找同一窗口内声明了 `AXShowAlternateUI` 和 `AXShowDefaultUI` 的元素或祖先。进入展开区域的子控件时保留父控件界面，离开时恢复一次。AX 动作失败直接返回错误，不尝试其他输入路径。没有可用 AX 路径时，该方法核实前台 PID，并通过 AppKit 查询目标点实际接收鼠标输入的窗口后，使用系统输入队列移动可见鼠标。不接收鼠标输入的窗口和透明区域不会阻挡目标。检查失败返回 `FOREGROUND_REQUIRED`，不移动鼠标。结果中的 `hoverRoute` 标明 `accessibility` 或 `system-pointer`，`systemPointerMoved` 标明是否移动系统鼠标。该方法不激活、不抬起窗口，也不恢复焦点。其他输入或窗口变化可能与检查和分派交错。


-----

<a id="verification"></a>
## 验证

桌面检查要求给所选 helper 授权：正式版声明名称 `DSH Computer Use`，开发版声明名称 `DSH Computer Use Dev`。以系统提示为准，临时签名重建后可能需要重新授权。`--helper` 指向该应用内的可执行文件。裸二进制仅用于旧版本对比，不支持作为当前 helper 的覆盖路径。

运行 `python3 packages/experimental/cua-macos/native/tests/startup_e2e.py`，通过 LaunchServices 检查启动即退出、原始错误传递、过期就绪记录拒绝，以及卡住的新实例退出。检查使用自建应用，不申请系统权限。发布单元测试模拟签名；`build:native` 调用真实的 `codesign --verify --strict`，`launcher_identity_e2e.py` 验证 LaunchServices 授权归属。

使用 `python3 packages/experimental/cua-macos/native/tests/test_swift.py` 通过选定 Apple 工具链的 Swift Testing 框架和运行时路径执行离线单元检查；使用 `python3 packages/experimental/cua-macos/native/tests/protocol_e2e.py` 检查 JSONL 接纳、有序回复和 EOF 退出，不执行桌面操作。应用与协议端到端检查接受 `--helper` 以选择单独构建的对比二进制。 `python3 packages/experimental/cua-macos/native/tests/test_build_app.py` 验证应用发布、开发版构建、已签名目录复用、签名失败和损坏副本拒绝。开发者签名工具的单测由 `scripts/cua-macos-signing.spec.ts` 执行；真实签名验证命令见[开发者签名 skill](../../../../.agents/skills/dsh-cua-macos-signing/SKILL.md)。

运行 `python3 packages/experimental/cua-macos/native/tests/shared_helper_e2e.py --helper /absolute/helper`，通过测试自建的 AppKit fixture 核实并发启动、共享服务 PID、独立句柄、同一应用交接、请求级截图期限、连接清理和信号退出。需要已经给所选的正式版或开发版 helper 授予辅助功能和屏幕录制权限。`--without-desktop` 将检查限定为协议与进程生命期。

在已解锁的 macOS GUI 会话中运行 `python3 packages/experimental/cua-macos/native/tests/application_consent_e2e.py --helper /absolute/helper`，需要可用的 Apple Swift 编译器。它创建并清理自己的 AppKit 应用和独立 GUI 进程，检查元数据替换、冷启动与直接启动、共用 Bundle ID、独立程序重启后的持久路径身份，以及删除运行中可执行文件后的选择行为。默认身份检查不需要辅助功能或屏幕录制权限。添加 `--desktop` 可读取完整测试应用的控件，通过状态文件验证 AX 按钮点击，截取窗口，并记录删除可执行文件后的观察结果；此模式要求已有两项系统权限。

在 GUI 登录会话中运行 `python3 packages/experimental/cua-macos/native/tests/launcher_identity_e2e.py`，验证两个嵌套 GUI 启动器启动 helper 后，授权归属仍为 helper 自己，多条连接得到相同名称和图标。检查自行创建应用并清理 LaunchServices 注册，不申请辅助功能或屏幕录制权限。 运行 `python3 packages/experimental/cua-macos/native/tests/nested_application_e2e.py`，用独立签名的测试应用验证 helper 在外层 `.app` 之外保留签名发布、并发发布和服务退出。

构建并解锁 Mac 后运行 `python3 packages/experimental/cua-macos/native/tests/axless_e2e.py`，验证应用移除并恢复 AX 根节点的窗口。检查需要已有辅助功能/屏幕录制权限，会拒绝过期元素 ID，捕获无 AX 窗口，通过 fixture 状态文件核实坐标点击，并检查恢复。不会修改系统权限设置。

运行 `python3 packages/experimental/cua-macos/native/tests/observation_benchmark.py --reference-helper /absolute/reference --candidate-helper /absolute/candidate --artifacts /private/evidence`，对比同一自建 AppKit 窗口中 35 行和 400 行合成内容的完整观察。每个 helper 先预热一次，再交替测量三次。除 helper 生成的应用和快照 ID 外，结果字段必须一致。报告保留原始耗时、字节数、哈希和回复，不设置 CI 性能阈值，也不声称内存表现。fixture 启动可能激活应用。运行时避免其他桌面自动化或编译任务。

使用 `--panels-only` 单独检查系统文件面板。fixture 窗口可加入应用集合，避免 Stage Manager 在后台输入时缩小它们。使用 `e2e.py` 或 `electron_e2e.py` 的 `--hover-only`，可独立于键盘和文件面板场景验证悬停。为 `e2e.py` 加上 `--alternate-hover` 可验证 AX 展开、进入子控件、点击和移出，并采样确认系统指针不变。`--input-overlays` 验证穿透鼠标的覆盖窗口允许悬停、拦截输入的覆盖窗口拒绝悬停且不移动指针。

构建后运行 `python3 packages/experimental/cua-macos/native/tests/e2e.py`，操作一个隔离的双窗口 AppKit fixture。fixture 独立记录按钮计数、Unicode 文本、实际滚动位置、右键回调和拖动释放位置。滚动、右键按下/抬起和拖动按下/抬起计数每次手势必须恰好增加一次。检查还验证真实 NSOpenPanel sheet、路径输入的键盘路由和选中文件 URL，并覆盖范围内快照替换、截图尺寸、过期应用清理和 EOF 退出。`--artifacts DIRECTORY` 写出仅包含 fixture 的截图和私有协议记录；协议记录包含运行中应用清单，不用于公开发布。

Blender 键盘检查使用 `python3 packages/experimental/cua-macos/native/tests/blender_keyboard_e2e.py --blender /absolute/path/to/Blender.app/Contents/MacOS/Blender`。它以独立用户目录启动一个采用出厂配置的 GUI，观察 Text Editor 的实际文本、选区和修饰键标志，检查 Command+A 替换、Shift+Left 选区及修饰键释放后的普通输入。需要解锁的 macOS 会话和辅助功能权限。测试会激活自建实例，运行时避免并发桌面自动化。`--helper` 选择以前兼容的二进制作为反例对照，`--artifacts` 指定新建私有证据目录的父目录。不下载 Blender 运行时。

文本节奏对比使用 `native/tests/text_input_benchmark.py`，参数为 `--reference-helper`、`--candidate-helper`、`--blender` 和 `--artifacts`。它在新建的 Blender Text Editor 中输入相同的 200/2000 字符合成文本，要求包括中文、emoji 和换行在内的完整文本一致。重复的 `--reference-arg` / `--candidate-arg` 选项选择 helper 启动参数。原始请求和已核实效果的耗时包含观察发布延迟，不含启动耗时；这些手动测量没有 CI 性能阈值。

隔离的 Electron/Chromium 检查使用 `python3 packages/experimental/cua-macos/native/tests/electron_e2e.py --electron /absolute/path/to/Electron.app/Contents/MacOS/Electron`。省略 `--electron` 时使用桌面工作区已安装的运行时，检查不下载 Electron。渲染器禁用 Node 集成，启用上下文隔离和 Chromium 沙箱，使用独立 userData/sessionData/log 目录及本地 fixture 页面。渲染器的点击/输入事件通过主进程写出独立观察，测试动作仍通过原生 helper 执行。AX 轮询等待 Chromium 辅助功能启用后的真实控件。原生和 Electron 子进程组由测试持有，在删除临时文件前停止。可选产物包含仅有 fixture 的截图和私有请求记录。

运行 `python3 packages/experimental/cua-macos/native/tests/capabilities_e2e.py --helper /absolute/helper --artifacts /private/evidence`，通过隔离的 AppKit 接收方验证未运行应用的发现和启动、Unicode 选区、多行纯文本/HTML 粘贴、中键/修饰键手势及数字键盘身份。需要已有辅助功能/屏幕录制权限，接收方实际状态与分派结果分开记录。 添加 `--click-only` 可在后台测试窗口中验证按住时长、AX 路由和取消、超时后的松开事件，不发送键盘或剪贴板输入。


运行 `python3 packages/experimental/cua-macos/native/tests/paste_e2e.py --artifacts /private/evidence`，验证自有 AppKit 应用在后台接收 Paste 动作但不读取数据时返回 `PASTE_NOT_CONSUMED`，以及前台读取同一次粘贴后成功。测试要求 Mac 已解锁并已授予辅助功能权限，只激活自有的两个应用，并独立记录收到的动作和文本以核对 helper 回复。

-----

## 延伸阅读

- [macOS 提供方](../README.zh.md)

## 开发备注

无。
