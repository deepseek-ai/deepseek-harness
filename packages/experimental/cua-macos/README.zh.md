---
description: "通过按应用和窗口限定的对象，观察和操作原生 macOS 应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua-macos

[English](README.md) | 中文

## 概述

检查 macOS 权限，选择运行中的应用和窗口，读取辅助功能树，从选定窗口截图并发送输入。标准及其他非 PTC preset 通过 `cua_run_code` 使用保留对象；PTC 使用已有运行时。Swift 辅助进程直接使用 macOS 框架，并改写选取的 MIT 许可 Cua Driver 行为。[共享 CUA 包](../cua/README.zh.md)负责工具注册和专用运行时；本提供方负责原生操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

helper 为授权提示和已授权应用列表提供 64 像素 PNG 图标。读取图标不会启动应用或检查窗口，图标不决定可复用授权。

helper 通过 LaunchServices 作为独立应用运行，正式版为 `DSH Computer Use.app`，源码开发版为 `DSH Computer Use Dev.app`。辅助功能和屏幕录制权限属于此应用。授权引导使用启动时记录的责任应用 bundle URL、标识、文件名和系统图标；系统归属信息不可用时使用独立 helper 自身的 bundle。拖动和 Finder 选择通过应用发现模块读取磁盘上当前的 bundle 标识及可执行文件。页面和引导框统一显示应用的 `.app` 文件名。其他构建更新 `current.json` 后，已有连接仍指向正在运行的应用版本。 helper 嵌套在其他 `.app` 中时，会从经过校验的独立副本启动，存放与校验规则见[原生构建与服务](native/README.zh.md#build-and-service)。

权限请求打开对应隐私设置页和原生悬浮引导框。引导框首次选择面积最大的设置窗口，随后按窗口 ID 跟随。它使用普通窗口层级，紧邻所选窗口上方排列，使认证弹窗保持在其上方。定位读取窗口边界，不申请辅助功能权限。引导框等到识别出设置窗口后才显示；打开设置失败时独立显示手动导航说明。材质的透明度遮罩为面板和阴影提供圆角。最新请求替换共享引导，连接清理只关闭自身创建的引导。应用不可用时仍尝试打开设置，并在页面报告失败原因。权限已授予时只打开设置；显式进入设置会关闭原有引导。系统拒绝打开设置时报告 `SETTINGS_UNAVAILABLE`；应用目标缺失或被替换时报告 `APPLICATION_UNAVAILABLE`。系统设置决定是否接收拖入的应用，以及是否要求重新启动。

provider 按当前界面语言生成引导和恢复文案，不支持的语言使用英语。将引导框内的应用拖入权限列表并开启开关；已有此应用时直接开启现有条目。拖动时隐藏引导框，放置被接收后关闭，拖动取消或被拒绝后恢复。返回按钮关闭引导框并返回之前的应用。右键点击应用行，或点击它使引导框获得键盘焦点后按 Return、空格，可在 Finder 中选中同一应用。原生引导打开期间，每隔 `permissionPollIntervalMs` 检查权限和窗口位置，默认 1000 毫秒；在确认授权、用户关闭、系统设置窗口消失或所属连接清理时关闭。拖动应用不代表授权完成。若 macOS 提示退出并重新打开应用，请按提示操作；系统不会自动终止共享 helper。

-----

<a id="use-this-package"></a>
## 使用本包

本包是仅限 macOS 的可选依赖。本地开发时运行 `pnpm --dir packages/experimental/cua-macos run build:native`，在 `native/bin` 下生成临时签名应用及 `current.json`。正式打包需要指定 `--identity "Developer ID Application: <name> (<team>)"` 并完成公证，参见[原生构建与服务](native/README.zh.md#build-and-service)。安装版保留分发时的签名。位于 Electron `app.asar` 归档内的包从同级的 `app.asar.unpacked` 目录读取应用，该目录由 Desktop 安装包提供；已安装包缺少应用时，准备阶段报错并给出预期目录。源码准备需要 Apple Command Line Tools 提供的 Swift 和 Python 3。

从仓库运行 Web 时，在插件页开启 [Computer Use](../cua-bundle/README.zh.md)。首次启用会在 macOS 14 及以上准备本机组件。现有 Web profile 保持选中时，后续构建继续检查更新。未开启的 profile 不准备原生组件。也可以显式加载源码覆盖层：

```sh
pnpm dsh headless --patch packages/experimental/cua-macos/examples/macos.cordis.yml --dump-config
```

配置输出命令不发起模型请求。执行真实任务时，将 `--dump-config` 替换为任务提示，并配置该 profile 的模型凭据。配置挂载 computer-use 注册表和本 provider；使用前需移除已有的竞争 provider。helper 需要辅助功能权限来读取 AX 和输入，需要屏幕录制权限来截图；通过 Computer Use 权限页打开系统设置并添加 helper。源码构建的应用包名为 `DSH Computer Use Dev.app`，Info.plist 声明名称 `DSH Computer Use Dev`；授权时选择开发版条目。`getCapabilities` 返回提供方声明的平台能力，以及实际查询的权限和锁屏状态。桌面会话锁定或不可用时，界面观察与输入会在分派前拒绝，需由用户解锁 macOS 后继续。`listApps` 和 `cua.getState` 列出运行中的应用。`findApps(query)` 按名称、bundle ID 或绝对路径搜索 macOS 标准应用目录。`getApp` 按唯一名称、bundle ID、路径或运行中的 PID 选择应用，取得应用许可后，在需要时后台启动尚未运行的应用。授权前从磁盘读取应用的 Bundle ID 和可执行路径，在启动前后重新读取并核对；没有 Bundle ID 的应用使用规范化的可执行路径复用授权。找到指定的安装包后，`getApp` 用可执行文件路径查找已有进程，进程显示名可以是其他语言。需要启动时，macOS 打开指定的安装副本，也可以复用授权期间启动的进程。helper 等待应用完成启动后返回运行状态。启动后验证失败会使待启动句柄失效，但进程可能仍在运行；应先查看运行中的应用，再取得新句柄。返回对象时不读取 AX，也不激活应用。启动被取消时，应用可能已经运行。模型指引要求先在后台观察和输入，不在初始化或每次动作前激活应用。窗口隐藏或最小化时，先尝试 `app.show()` 或 `window.show()`，再重新观察。它请求取消隐藏和恢复最小化，不主动激活、抬起窗口或切换桌面空间；应用级恢复选择焦点窗口、主窗口或唯一 AX 窗口。结果通过 `windowId` 指明选中的窗口，未选中时为 null；`foregroundChanged` 比较操作前后的前台应用和最上层窗口，无法取得完整观察时为 null，返回后仍可能发生焦点变化。恢复失败或窗口仍不可用时，说明需要前台的步骤，再调用 `app.activate()` 或窗口声明的 `AXRaise` 动作并重新观察。必须使用前台时，以完成任务为先。应用收到输入后仍可能改变焦点，后台投递不保证用户操作始终不受干扰。

源码构建默认使用 `sourceSigning: ad-hoc` 临时签名，不创建证书或钥匙串。二进制变化后可能需要重新授权。需要减少开发重建和跨 worktree 的授权次数时，在 DSH home 的 `cordis.patch.yml` 中选择已有证书及其钥匙串绝对路径；`cua` 是加载 `@deepseek-ai/dsh-experimental-cua-macos` 的节点 ID：

```yaml
- id: cua
  config:
    sourceSigning:
      identity: "<certificate SHA-1 fingerprint>"
      keychain: "/Users/<user>/.cua-macos-keys/dev/signing.keychain-db"
```

`identity` 是已有证书名称或 SHA-1 指纹，`keychain` 是必填的绝对路径。开发者负责生成和解锁钥匙串；构建只使用所选证书。合并配置时保留该节点已有的其他字段。仓库的[开发者签名 skill](../../../.agents/skills/dsh-cua-macos-signing/SKILL.md)指导 Agent 在 `~/.cua-macos-keys/` 中生成、复用和移除身份，并只将选择身份的配置写入 DSH home。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `agentPreset` | `ptc` | 为该 preset 提供原始 `cua`，为其他已组合的 preset 提供 `cua_run_code`；`false` 表示全局注册原始 `cua`。 |
| `standaloneRunCode.runtime` / `standaloneRunCode.executor` | 共享 Node / PTC 上限 | 专用 CUA 运行时的资源、启动和嵌套调用设置；参见 [CUA](../cua/README.zh.md)。 |
| `allowedApps` | `[]` | 旧路径和签名许可，只导入 profile 存储一次供撤销，不授予新 Bundle ID 身份访问权限。 |
| `helperPath` | 包内可执行文件 | 已签名 helper `.app` 内可执行文件的绝对路径；裸二进制会触发 `NATIVE_APPLICATION_REQUIRED`。 |
| `requireSystemPointerApproval` | `true` | 主任务首次显式请求移动系统指针时询问用户。设为 `false` 时仅本次显式移动免询问。 |
| `sourceSigning` | `ad-hoc` | 源码签名：`ad-hoc` 临时签名，或 `{ identity, keychain }` 指定已有证书及钥匙串路径。安装版和 `helperPath` 忽略此项。 |
| `buildTimeoutMs` | `300000` | 原生组件准备的最长时间。 |
| `timeoutMs` | `30000` | 单次操作截止时间，取消后可能已发生部分输入。 |
| `connectTimeoutMs` | `5000` | 连接或启动共享 helper 的截止时间。 |
| `permissionPollIntervalMs` | `1000` | 原生引导打开期间检查权限和窗口位置的间隔，单位为毫秒。 |
| `screenshotTimeoutMs` | `5000` | 截图总期限，包含排队时间，且不超过 `timeoutMs`。 |
| `axTimeoutMs` | `3000` | 每次 Accessibility 系统调用的截止时间，与完整操作截止独立配置。 |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 请求与响应字节限制。 |
| `maxClipboardBytes` | `33554432` | 粘贴时保存原剪贴板内容的字节上限；超限会在替换前拒绝。 |
| `pasteReadTimeoutMs` | `1000` | Paste 命令返回后等待剪贴板读取的上限；到期返回 `PASTE_NOT_CONSUMED`。 |
| `maxAppMatches` | `20` | 已安装应用搜索的结果上限；范围过大的查询会被拒绝，需要缩小名称范围。 |
| `maxElements` / `maxDepth` | `5000` / `50` | 读取树时的默认值。每次读取可单独调高或调低任一项。查找粘贴菜单始终使用配置值。[决策理由](../../../.agents/notes/implemented/architecture/2026-11-09-cua-ax-traversal-defaults.zh.md) |
| `maxClickHoldMs` | `5000` | 显式点击按住时长的上限，单位为毫秒，接受非负整数。设为 0 时只允许立即松开。 |
| `dragDurationMs` / `dragSteps` | `400` / `20` | 拖动时长和移动分段数。 |
| `textEventIntervalMs` | `0.25` | 每个 Unicode 按下或抬起事件后的间隔，范围为 0 至 1000 毫秒。击键节奏独立。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-cua-macos)列出全部字段。原生工具调用使用 `{method, params}`，模型可以看到每个方法的完整参数定义。`getApp` 返回每个面向应用的操作所需的 `appHandle`，`app.getWindow(windowId)` 返回负责截图和指针输入的对象。

`pressKey(key, modifiers?)` 按下并松开一个键。使用快捷键时单独传入修饰键，例如 `pressKey('a', ['command'])`。单独调用 `pressKey('shift')` 时，按下事件带有 Shift 标志，释放事件清除该标志。`+` 和 `plus` 都会发送 Shift 和等号。macOS helper 接受 `command`/`cmd`、`shift`、`option`/`alt`、`control`/`ctrl` 和 `fn`，并映射到对应物理键。按键名由平台定义；数字键盘名称（`KP_0` 到 `KP_9`、`KP_Enter` 和数字键盘运算键）保留独立的物理键码。`typeText` 发送字面文本，包括其中的换行和制表符。短按使用 App 对象上的 `pressKey`。

长按时，在 `run_code` 或 `cua_run_code` 中调用 `app.sendKeyEvent('w', 'down')`。首次按下后，该键在同一次执行的后续工具调用中保持按下。对自己已按住的普通键再发一次 `down`，原接收进程会收到一次带重复标志的按下事件。调用方决定是否重复和间隔多久。控件可能过滤模拟的重复事件，可通过控件的实际变化确认效果。松键只需一次 `up`。每个键可分别松开。例如先按 W，再按 D，松开 D 后 W 仍按着。程序正常返回、出错退出或用户暂停时，helper 为本次执行仍按着的键逐一发送松开事件，每个事件都发回原接收进程。后续执行不能释放前一次执行的键。

Agent 销毁和插件卸载会取消并等待完整工具调用，包括图像接入检查和附件存储。已经开始的图像写入必须结束后，销毁才会返回；已取消的调用不会返回成功截图。

CUA 工具在读取 AX、窗口标题、截图、激活和输入前检查应用授权。首次选择应用时询问用户，可选择本会话允许、拒绝；profile 提供持久存储时还可保存长期授权。会话许可按对话和应用身份持久化，重启 DSH 或关闭 Computer Use 后仍可复用，其他对话需要单独授权。应用身份使用区分大小写的 Bundle ID，因此不同路径下的版本和副本共用许可与撤销决定，不受签名状态影响。运行中应用具有有效 Bundle ID 时，即使操作系统无法提供可执行路径，也可以授权。路径可取得时仍核对所选目标，进程实例和窗口归属检查始终保留。缺少 Bundle ID 时，授权必须取得规范化可执行路径。在同一路径下重启或更新会沿用许可，移动或复制到另一个路径则需要重新决定。这项规则不验证发布者身份，其他程序声明相同标识，或替换路径授权所对应的可执行文件时，也会继承许可。拒绝后，同一会话不会反复询问。撤销与长期许可的保存共用队列，在队列内读取并移除许可，然后使相关 Agent 连接失效并等待原生清理完成，不自动重放输入。同一 Agent 连接中的其他应用也需要重新选择，其他应用的会话许可和长期许可仍可复用。设计理由见[应用授权决策](../../../.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.zh.md)。这些检查的范围是 CUA 调用。persistent PTC 与已授权的 shell 仍按各自执行权限运行。

原始 `getState` 操作返回经过校验的状态字段，以及按本次披露选项生成的完整文本。原生 helper 还返回供原生检查使用的结构化元素诊断数组，其中 `elementId` 是不透明字符串；工具投影会从模型文本和结构化工具值中移除这份重复数组。

AX 观察默认只展示菜单栏入口。使用 `app.getAccessibilityTree({ includeMenus: true })` 展开菜单内容，使用 `app.getAccessibilityTree({ details: true })` 读取标识符、全局 point 坐标和完整动作名。原始 `getState` 也接受这两个选项。每次读取都会替换应用当前的快照；应使用该次读取返回的元素 ID。传入 `maxElements` 或 `maxDepth` 可调整本次读取的上限。树被截断时会提示触发的上限。

实际值与占位文字分别展示。有名称、状态或可用动作的分组和滚动区域保留独立行。同一节点中重复的名称、描述和帮助只显示一次。实际值、占位文字和 URL 即使文字相同也保留各自含义，不删除不同节点共有的正文。相关控件明确展示可写性，包括 `AXIncrementor`；`unknown` 表示系统未报告。缺少可选状态字段不代表 false。读树时，AXValue 或 AXSelectedTextRange 的可写性探测返回 -25200，会将该字段保留为未知并继续读取其他节点。实际写入仍严格校验；权限、通信和失效元素错误仍向上传播。超出当前值长度的 UTF-16 选区标为不可用。树中的动作简称可能省略 AppKit 的 target 和 selector 信息。调用 `performAction` 时使用 `listActions(elementId)` 返回的完整名称。

调用 `inspect(await app.getAccessibilityTree())` 展示整棵树，也可以先筛选返回的文本，再将匹配项传给 `inspect`。若后续截图失败，先前已显式输出的 AX 文本仍然可见。

截图诊断使用带工具请求 ID 的 `[cua-screenshot]` 记录。原生阶段记录经本次 Agent 连接返回，覆盖窗口及 AX 几何检查、系统截图、PNG/Base64 编码和响应写出。Host 调试日志补充发送、响应和清理耗时。每次请求最多保留 8192 字节完整诊断记录，超限会明确标记；截图失败时附在错误中，保留到 Session trace。记录只含阶段、耗时和错误码，不含窗口标题、AX 正文或图片内容。

原生准备通过文件锁串行构建和签名，将完整应用保存在 `native/.build/prepared` 下的内容摘要目录中，再原子更新 `current.json`。旧连接继续使用原应用，相同构建复用已有文件，损坏的副本拒绝使用。取消或准备失败后，先完成受管进程清理再释放锁。

### 接入外部执行环境

使用 persistent PTC 时，在 macOS 配置后追加 `--patch packages/experimental/cua-macos/examples/persistent-ptc.cordis.yml`。该 provider 为存活的 Agent 保留变量，并遵守当前选择的文件沙箱策略。调用方导入适配模块，并提供当前执行中已授权的 `tools.cua` 绑定。persistent PTC 会在 CUA 指引中收到安装目录内 bridge 的文件 URL，项目无须安装本包。下面的例子用于能从自身安装目录解析本包、且已提供 `tools` 的外部宿主。在其他已组合的 preset 中，`cua_run_code` 已经提供全局对象，并通过[共享 CUA 包](../cua/README.zh.md)保留变量：

```javascript
import { connectCua } from '@deepseek-ai/dsh-cua/bridge'
const cua = connectCua(() => tools.cua)
const app = await cua.getApp("com.apple.TextEdit")
const windows = await app.getWindows()
if (windows.length === 0) throw new Error("Open a TextEdit window first")
const window = await app.getWindow(windows[0].windowId)
inspect(await window.getScreenshot())
```

独立浮层有自己的窗口 ID。需要截图或点击浮层时，从 `app.getWindows()` 中选中它。

使用 `cua` API 发现并选择应用（`listApps`、`getState`、`findApps`、`getApp`）；使用选定的应用来激活它、枚举其窗口并选择窗口。截图和指针输入都要求选择窗口，不只在存在多个窗口时才需要。`getApp` 和 `app.getWindow(windowId)` 返回时不读取 AX；根据 `getWindows()` 中的标题与位置选择窗口。

`getWindow` 不发送原生请求；截图和指针输入会拒绝已关闭或属于其他应用的窗口。元素操作前须显式读取 `getAccessibilityTree()`。截图不要求 AX 读取成功。所有坐标输入（包括相对坐标）都要求先成功读取覆盖该窗口的 AX 或取得截图；绝对像素坐标要求已交付的截图。已确认归属但没有 AX 界面的窗口在显式观察时返回空快照。在单个 API 实例内，门面按应用句柄保存一份当前辅助功能快照，该句柄的所有应用对象和窗口对象共享它，包括重复选择。读取任一窗口都会替换该快照；元素操作使用最新快照 ID，因此应使用最新树中的元素 ID，不应假定旧 ID 仍指向同一控件。读取失败不会发布部分快照；可以重新读取，但不要重复此前的输入。窗口对象负责截图和指针输入。键盘方法保留在 `app` 上，因为输入跟随应用的当前焦点。

普通 `mouseMove(target)` 默认通过辅助功能悬停。如果目标或其祖先没有同时声明 `AXShowAlternateUI` 和 `AXShowDefaultUI`，则返回 `HOVER_UNAVAILABLE`，不会弹窗。只有任务确实需要移动用户的鼠标时，主任务才调用 `win.mouseMove(target, { useSystemPointer: true })`。用户允许后，Host 重新检查窗口和目标位置，再执行本次移动。每次移动系统指针都要显式传 `useSystemPointer: true`。省略参数或传 `false` 时使用辅助功能悬停。拒绝时不派发输入。会话记住此次选择，直到关闭会话或重启 DSH。

`paste(text, { format: "text" | "html" })` 临时提供指定格式的剪贴板内容，并调用应用已启用的标准 Paste 菜单命令。临时格式保留到剪贴板读取方请求其数据，然后只在仍持有剪贴板时恢复保存的全部原格式，保留期间产生的新复制内容。粘贴操作共用跨进程锁，取消会等待辅助进程清理。强制终止进程可能阻止恢复。应用不支持 Paste 命令时明确失败，不自动改成逐字输入；`typeText` 仍单独提供按键事件输入。

`selectText` 通过可写的 `AXSelectedTextRange` 选中唯一的字面文本，或把光标放在它的前后。紧邻的前后文用于区分重复文本。选区操作保留其余文字和格式，并核对实际 UTF-16 范围；控件不支持、文本不存在、匹配不唯一或文字变化时明确失败，不自动改用键盘输入。AX 文本包含可用的 `selectionWritable`、选区范围和选中文字。

截图要求附件服务可用，并确认当前模型支持图片输入。共享附件接入校验规范 Base64、图像数据及配置容量，然后保存一次图片。程序调用方仍可取得原生数据，模型内容包含坐标元数据和持久图片引用。响应字节上限在解析前执行。

`win.click(id)` 向元素中心发送鼠标事件，`win.click([x, y])` 向给定位置发送鼠标事件。`click(id)` 和 `mouseMove(id)` 使用的元素须属于所选窗口。后台控件优先用 `invoke(id)` 执行默认动作。需要鼠标输入时，先激活应用并重新观察目标。系统打开或保存面板的鼠标点击投递给已核实的文件面板服务窗口。在 macOS 14.2 及以上版本，截图只包含所选窗口，图像按该窗口的边界对齐。

`mouseMove`、`click` 和 `drag` 的绝对坐标使用 `[x, y]` 元组；`scroll` 使用命名的 `x` 和 `y`。它们都使用最近返回截图中的像素。传入 `relative: true` 时使用 0～999 的千分比整数；省略或传入 `false` 时使用像素。相对坐标可基于成功的 AX 读取或截图，绝对坐标必须先截图。Host 根据实际送入模型的图片尺寸换算原生 point，包含附件归一化和模型请求阶段的缩放。999 映射到窗口边缘以内。坐标选项不适用于元素 ID。窗口宽高与最近一次观察不同时，在输入前返回 `WINDOW_CHANGED`，即使原始坐标调用不传快照 ID 也会检查；重新读取 AX 或截图后再操作。单纯移动窗口不使窗口内坐标失效。截图和鼠标输入会核对所选窗口的辅助功能框与显示边界；已知两者不一致时，在发送任何鼠标事件前返回 `WINDOW_CHANGED`。当 AX 保留完整窗口框时，这也会拦住 Stage Manager 变换后的窗口。需要重新读取状态；激活应用或抬起窗口仍须显式调用。元素声明的 AX 动作保持可用。缺少 AX 几何时保留无 AX 路径，不代表变换后的窗口一定可以操作。

保留的对象会在每次调用时获取当前工具绑定。外部运行时负责持久化、导入、取消和最终表达式值的序列化。截图返回保存的 `Image` 值，通过 `inspect` 显式展示。使用其他程序分派器的调用方可以通过 `./api` 的 `createCuaApi(dispatch)` 创建对象。

AppKit 的 sheet 可以出现在文档窗口的树里，并有独立的窗口 ID。对 sheet 发送鼠标输入时，先用 `app.getWindow(sheetId)` 选择它，再使用该窗口树中的元素 ID。只有应用当前获得焦点的 sheet 指向唯一的 Apple 面板服务窗口，且该服务仍聚焦于同一面板时，键盘输入才转交系统打开或保存面板。无法确认或存在歧义的远端接收方会在输入前报错。

元素点击使用当前快照中的不透明元素 ID。左键支持单击或双击；右键和中键支持单击。点击和拖动选项可指定按键与修饰键名称。拖动期间保持指定按键，并在移动和释放事件中携带修饰键。AX 文本标明禁用控件、`valueWritable=true` 和可读取的 `selected` 状态。动作返回只表示输入已分派。可视指针或点击标记可以独立绘制；AX 动作无需移动系统指针。窗口定向鼠标输入仍可能改变应用焦点、选区或对话框。输入后需要读取状态确认结果。`STALE_APP` 需要重新获取应用，`STALE_SNAPSHOT` 需要重新读取 AX。请求超时或取消会等待原生停止确认，保留仍可用的句柄；无法确认清理完成时关闭该 Agent 的连接。未返回系统回调的截图 RPC 占用唯一捕获槽位，新截图立即返回 `CAPTURE_BUSY`，AX 和输入仍可使用。迟到图片被丢弃，真实回调结束后释放槽位。只有操作无法停止或清理失败时，才可能使共享进程及所有旧句柄失效。不能自动重试结果不确定的输入。关闭 Agent 会释放其连接和 AX 引用，但不会撤销应用中的修改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>操作分派与资源归属</summary>

对象接口将应用和窗口方法转换为 JSON 操作。在单个 API 实例内，它按应用句柄保存一份当前辅助功能快照；原生 helper 在该门面之后保留自己的应用快照和可选窗口快照。适配模块通过标准工具链保留授权、嵌套日志和图片接入。同一用户的相同 helper 构建由多个 Agent 和 Host 共享。每条连接独立保存句柄、快照、配置和取消状态，桌面操作通过全局队列执行。受管启动器将服务生命期交给这些连接，最后一条连接清理完成后服务退出。进程锁覆盖构建身份及真实可执行路径，防止重复启动或覆盖运行版本后产生路径冲突。原生句柄绑定进程身份及内核启动时间，快照中的 AX 引用只保存在辅助进程内。

[Zod 操作定义](../cua/src/protocol.ts)负责模型参数，并单独声明 Host 资源字段和内部续接操作。公共数据类型从这些定义推导。`pnpm exec tsx packages/experimental/cua-macos/native/generate-protocol.ts` 生成原生 JSON Schema 和 Swift 字段、枚举校验表；包测试检查产物是否同步，并验证模型不能提交 Host 专属字段。原生目标验证、资源上限和操作行为仍在执行处检查。

[AX 文本格式化](native/Sources/CuaNative/AXTextFormatter.swift)只接收已读取的节点数据。AX 遍历器独自分配不透明元素 ID 并保存原生引用，格式化不维护另一套快照或目标注册表。

原生请求 ID 与工具日志中的调用 ID 一致。成功的激活操作会在原始工具结果中保留前台操作信息，以及操作前后的即时焦点观察。应用已在前台时跳过重复激活。无法确认时保留原请求。这些观察不能确认其他焦点切换的发起者，也不代表操作已经完成。

每次观察在同一批 AX 请求中读取节点角色和元数据。组节点和滚动区域节点只提供子节点，未使用的元数据错误不会导致它们被拒绝。不支持批量读取时保留逐个属性读取。AX 遍历对每个原生身份只访问一次，包括表示同一元素的不同代理引用，避免循环子节点重复展开整个子树。[源码清单](native/upstream.json)记录改写的上游行为和本地 Swift 模块。AppKit 使用主事件循环，独立串行执行器持有 AX 引用并发送同步输入。一条请求在截图和结果发送期间仍独占执行。本包不发布 invariant 入口，因为没有需要对照的独立注册表投影或持久执行器状态。协议验证、目标身份和资源清理由对应实现负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Computer-use 注册](../../computer-use/computer-use/README.zh.md)
- [原生协议](native/protocol.schema.json)
- [对象接口](../cua/src/types.ts)

-----

<a id="model-experience"></a>
## 模型体验

### 原生应用操作

#### 模型可见内容

配置指定的 PTC preset 通过 `run_code` 获得一个定义各方法参数的 `cua` 操作工具。其他已组合的 preset 获得 `cua_run_code`，其中全局 `cua` 对象可直接使用，程序内只绑定 `tools.cua`。下方逐字引用 PTC 操作指引，其中使用 `tools.write`、`tools.grep` 和 `tools.read` 处理较大的 AX 树。`cua_run_code` 版本使用 `node:fs/promises` 保存树，再在程序外直接调用普通会话工具搜索；初始化和程序说明由[共享 CUA 包](../cua/README.zh.md#model-experience)选择。

##### PTC 操作指引（原文）

```markdown
macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.

Use cua to observe and operate native applications. Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions. All methods are async. Actions report dispatch evidence, not verified completion. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI actions and ask the user to unlock the desktop session; null or unknown means verify a usable unlocked desktop session first. cua.getApp requests user consent; if access is denied or revoked, stop using that application until the user explicitly permits another request, and never bypass a refusal or switch tools to avoid it. Never replay uncertain input without a fresh observation.

Call inspect(...values) to display selected observation results.

Signatures show resolved return values after await. ActionResult = { dispatched: boolean, foregroundChanged?: boolean | null }; foregroundChanged is omitted when not sampled and null when the sample is unavailable. JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }; numbers must be finite. App is the application object with readonly app.appHandle: string (opaque) and the methods listed below for app level. Window is the window object with readonly window.windowId: number and the methods listed below for window level. Neither object carries pid.

Setup and discovery:
- cua.getCapabilities() -> { platform: string, permissions: { accessibility: boolean, screenRecording: boolean }, appLevelAccessibility: boolean, systemPointer: boolean, keyboard: ('app' | 'window')[], sessionLocked: boolean | null, methods: string[], coordinateSpace: 'screenshot-pixels', browser: false } — inspect reported permissions, sessionLocked, methods, and keyboard scopes without requesting permissions.
- cua.listApps() -> { id: string, displayName: string, isRunning: true, pid: number }[] — enumerate running applications.
- cua.findApps(query: string) -> ({ id: string, displayName: string, path: string } & ({ isRunning: true, pid: number } | { isRunning: false }))[] — search installed applications, including stopped matches; only running matches carry pid.
- cua.getState() -> { apps: { id: string, displayName: string, isRunning: true, pid: number }[], browsers: [] } — summarize running applications; this is not an accessibility observation.
- cua.getApp(selector: string) -> App — select an application by name, bundle ID, absolute path, or running PID string, obtain consent, launch in the background if needed, and return without reading AX or activating the app.
- app.getWindows() -> { windowId: number, appName: string, title: string, bounds: { x: number, y: number, width: number, height: number }, isOnScreen: boolean, onCurrentSpace: boolean | null }[] — enumerate windows with global native bounds; null onCurrentSpace means unknown Space membership.
- app.getWindow(windowId: number) -> Window — select a window by an ID from getWindows without reading AX. Providers reject closed or foreign windows when operating on them.
- app.activate() -> ActionResult — request explicit foreground activation; use only when foreground access is required.
- app.show() -> { dispatched: boolean, windowId: number | null, foregroundChanged: boolean | null } — unhide the app and restore its selected, focused, main, or sole window without activation.
- window.show() -> { dispatched: boolean, windowId: number | null, foregroundChanged: boolean | null } — unhide and restore that explicit window without activation.

## Accessibility tree
Available at app or window level depending on the platform.

Read getAccessibilityTree explicitly before using element ids. Selection and screenshots do not read or replace the current AX snapshot. Element ids are opaque strings from the latest successful tree; the object facade keeps one current snapshot per app across its repeated app and window objects, a new read replaces it, and a failed read invalidates the previous one. Repeated strings can appear for different elements, so do not reuse an old id blindly, and element operations do not fall back to pointer input or typing.
- getAccessibilityTree(options?: { includeMenus?: boolean, details?: boolean, maxElements?: number, maxDepth?: number }) -> string — set the node count or depth for one read. Omitted limits use the provider settings. includeMenus expands menu contents and details adds identifiers, native bounds, and complete action names. macOS accepts maxElements up to 100000 and maxDepth up to 512. If the tree is truncated, select a narrower window or raise the reported limit on the next read. In persistent PTC, capture a large tree with const tree = await win.getAccessibilityTree(). Filter its lines in memory, or save it with await tools.write({ file_path: path, content: tree }) to a new workspace file. Search its contents with tools.grep({ path, pattern }) and use tools.read around a matching line. Use inspect to display the matches you need. Use element ids from the file only while that observation is current.
- listActions(elementId: string) -> string[] — list the actions an element advertises.
- invoke(elementId: string) -> ActionResult — invoke the element's default action; dispatched is false when it has none.
- performAction(elementId: string, action: string, argument?: JsonValue) -> ActionResult — perform an observed action with an optional direct JSON argument.
- setValue(elementId: string, value: JsonValue) -> ActionResult — write a control value.
- selectText(elementId: string, text: string, options?: { prefix?: string, suffix?: string, selectionType?: 'text' | 'cursor_before' | 'cursor_after' }) -> ActionResult — select one literal occurrence or place the cursor beside it, using adjacent context to disambiguate.

## Simulated mouse
Use an explicit window for screenshots and pointer input. Before coordinate input, including relative coordinates, obtain a successful getAccessibilityTree observation covering that window or take its screenshot. Absolute pixel coordinates require a returned screenshot.
- getScreenshot() -> Image — capture the selected window as a stored image with readonly attachmentId, path, width and height; pass it to inspect to display it.
- mouseMove(target: string | [number, number], options?: { relative?: boolean, useSystemPointer?: boolean }) -> { dispatched: boolean, foregroundChanged?: boolean | null, hoverRoute: 'accessibility' | 'system-pointer', systemPointerMoved: boolean } — request a mouse move to the target without pressing a button; inspect hoverRoute and systemPointerMoved, and expect no automatic pointer restoration. Default hover requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without that route, HOVER_UNAVAILABLE is returned before sending input. Physical movement requires an unobscured foreground target. Explain any necessary activation and observe the target again.
- click(target: string | [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', clickCount?: 1 | 2, modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], holdMs?: number, relative?: boolean }) -> ActionResult — click an element id or point, or perform a left-button double-click; holdMs controls the press duration of each press. click is a Window method: select a window with const win = await app.getWindow(windowId), then call win.click(target). For a background control’s default action, use app.invoke(id). For a mouse click on a background app, call app.activate() first and re-read the target. Both target forms send mouse-down and mouse-up events. click(id) uses the center of the full element bounds. If that center is outside the window, take a fresh win.getScreenshot() and use click([x, y]) on a visible part of the control in screenshot pixels. A background app can ignore the events even when dispatched is true. Verify the expected effect, such as a changed selection, before typing or retrying.
- scroll(options: { x: number, y: number, deltaLinesX: number, deltaLinesY: number, relative?: boolean }) -> ActionResult — scroll at a point; deltas are integers from -10 to 10 with at least one nonzero, and positive values reveal content above or left.
- drag(from: [number, number], to: [number, number], options?: { mouseButton?: 'left' | 'right' | 'middle', modifiers?: ('command' | 'control' | 'option' | 'shift' | 'fn')[], relative?: boolean }) -> ActionResult — drag between two points of one window.

A string target is an element id; coordinate targets are [x, y] and are pixels in the latest returned screenshot by default. With relative: true they are integer thousandths of the window width and height from 0 to 999, based on the current AX observation or screenshot. Left clicks support one or two presses; right and middle clicks support one. FOREGROUND_REQUIRED means explain the need, then explicitly activate the target and observe again; activation is never automatic. Read fresh state after actions, and treat WINDOW_CHANGED, STALE_SNAPSHOT, and SCREENSHOT_REQUIRED as requiring the stated fresh observation or capture before any retry.

## Simulated keyboard
Available at app or window level depending on the platform.
- typeText(text: string) -> ActionResult — type literal text at the app's current focus; line endings send Return and tabs send Tab.
- paste(text: string, options?: { format?: 'text' | 'html' }) -> ActionResult — deliver text or HTML through the app's Paste command, restoring prior clipboard contents unless another writer changes them; a Paste failure is surfaced without substituting typeText, and PASTE_NOT_CONSUMED means inspect before any retry.
- pressKey(key: string, modifiers?: string[]) -> ActionResult — press and release one complete keystroke. For example pressKey('Tab', ['shift']) or pressKey('+'). Key and modifier names are platform-defined strings. Pass key and modifiers separately; do not pack them into a chord string.
- sendKeyEvent(key: string, direction: 'down' | 'up') -> ActionResult — send 'down' to hold a key across tool calls in one program, for example W down, D down, D up, W up. Holding a key on a physical keyboard can produce repeated key-down events after a delay. To send one such repeat for a non-modifier key this run already holds, send 'down' again. Each call posts one event. A control can filter repeats. Use the app's response to decide whether and when to repeat or release the key. When this program returns, throws, or the user pauses it, macOS releases only its remaining keys at their original recipients.

Raw tools use { method, params }: include appHandle for app calls and windowId for window calls, and use snapshotId with elementId for element routes. getAccessibilityTree maps to getState; getWindow has no raw method; getWindows maps to listWindows; getScreenshot maps to screenshot; cua.getState maps to listApps; every other named operation uses the same method name.

Only if the task cannot be completed without moving the user’s pointer, call await win.mouseMove(target, { useSystemPointer: true }). Prefer an advertised accessibility action, a click on a visible control, or browser tools when possible. The question interrupts the user. When approval is disabled an explicit move can act immediately. Pass true on every physical move, even after approval. Omitting the option or passing false uses the default hover route without prompting. Approval or refusal lasts until this session closes or DSH restarts. A refusal sends no input. If the user dismisses the request, ask again only if they request it. Wait for an outstanding request to finish. Subagents cannot request physical movement.
```

#### Token 影响

启用插件会增加固定参数定义和指导文本。直接调用原生 `cua` 工具时，结果文本和通过检查的截图会进入模型输入。在 TypeScript PTC 和 `cua_run_code` 中，程序用 `inspect` 选择要展示的文本和图片。在程序中保留应用或窗口对象不会增加提示词内容。窗口中有更多节点可读时，调高默认值或单次读取上限可能使返回的 AX 文本变长。每个可见辅助窗口（例如状态栏图标、菜单或工具提示）都会给 `getWindows()` 和原始 `getState` 的结果增加一条窗口记录。截图需要单独请求。

#### KV Cache 影响

工具结果追加到 Session 历史。修改插件配置或工具呈现方式可能改变请求前缀；保留应用对象不会改变已有历史。

## 已知限制与后续工作

读取较大的树仍受原生操作超时（`timeoutMs`）、单次 AX 调用超时（`axTimeoutMs`）和响应大小限制（`maxResponseBytes`）约束。

队列只排序单次原生请求。持有 app 对象不会为 Session 保留应用，[连续交互](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.zh.md)不分配跨调用所有权。一直不返回的系统截图 RPC 会占用唯一捕获槽位，重新创建 app 对象不会重置该系统连接。

<a id="known-limitations-and-deferred-work"></a>

- 最低支持 macOS 14；设置导航、拖放接收和权限刷新需要在各支持版本验收。若 macOS 要求在修改屏幕录制权限后退出并重新打开 helper，权限检查在重启前可能仍返回未授权。可以关闭引导框，不必终止其他连接。
- 所选设置窗口离开可见窗口列表时，引导框会关闭，包括切换桌面空间或最小化导致窗口不再可见的情况。返回后再次申请权限可重新打开引导。
- 只提供 macOS 原生实现，Windows 支持正在开发中。本包暂放在 `experimental`，待 Windows 支持完成后迁回 `computer-use` 组。不支持浏览器标签、启动应用、AX 差分、无法确认应用归属的系统面板，以及仅后台辅助类型的应用。
- 元素 ID 只对应用当前的辅助功能快照有效；之后的读取会替换它们。截图和指针输入都要求显式的窗口对象。
- 坐标使用包含标题栏的返回截图像素；`relative: true` 使用 0～999 的整数，由 Host 换算原生 point。窗口移动、应用变化及其他桌面使用者的操作可能与观察和输入交错。
- macOS 台前调度可能将后台窗口的尺寸与截图变为缩略图，当前无法保证这种状态下的完整画面与坐标输入；模型指引要求说明前台需求并避免反复抢回焦点。
- 后台输入依赖私有 SkyLight 符号，macOS 升级可能使其不可用，需在目标系统版本验证。
- 实测 Blender Unicode 输入曾出现分派成功但界面未显示文本，后台 AppKit 的 Command+A 曾未选中全文。输入后必须检查应用状态；工具返回成功只表示已分派。
- 源码构建默认使用 `ad-hoc`，二进制变化后可能需要重新授权。[开发者固定身份](../../../.agents/skills/dsh-cua-macos-signing/SKILL.md)保存在 DSH home 之外；删除 DSH home 只删除选择它的配置，不删除证书和私钥。正式分发应以固定 Developer ID 签名并完成公证；构建命令支持 `--identity` 指定签名身份，安装版保留分发时的签名。[权限页面](../cua/README.zh.md)提供 helper 授权入口和目标应用许可撤销。
- 发布打包不自动验证 GUI 启动、helper 身份或退出清理。发布维护者可在发布前，在已登录桌面的 Mac 上执行[分发 smoke](native/README.zh.md#build-and-service)；打包成功不能证明这些运行行为已通过验收。
- 已保存许可的条目显示一个已批准副本的名称、路径和图标，不枚举共享身份的所有安装副本。删除该副本后图标可能不可用，撤销仍作用于同一身份的所有副本。
- macOS 无法提供运行中应用的 Bundle ID 时，helper 仅在其报告的 bundle 可执行路径与实际进程路径相同时读取该 bundle，仍无标识则使用路径。只有 Bundle ID 和实际可执行路径均不可用时才拒绝生成授权身份；进程实例验证仍可能独立失败。
- 共享 CUA 包及 PTC 提供方负责程序执行和状态保留，本包负责原生操作。真实模型任务成功率需要在原生测试和协议测试之外单独评估。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
