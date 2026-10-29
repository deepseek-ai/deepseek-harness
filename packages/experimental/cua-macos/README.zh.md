---
description: "通过按应用和窗口限定的对象，观察和操作原生 macOS 应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua-macos

[English](README.md) | 中文

## 概述

检查 macOS 权限，选择运行中的应用和窗口，读取辅助功能树、截图并发送输入。外部持久执行环境可以保留这些对象。Swift 辅助进程直接使用 macOS 框架，并改写选取的 MIT 许可 Cua Driver 行为。本包不提供 PTC 运行时或变量持久化。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

helper 为授权提示和已授权应用列表提供 64 像素 PNG 图标。读取图标不会启动应用或检查窗口，图标不决定可复用授权。

helper 通过 LaunchServices 以独立的 `DSH Computer Use.app` 后台运行，辅助功能和屏幕录制权限归属于这个应用。权限页使用系统返回的应用名称和图标；无法查询归属时，以系统授权提示为准。

-----

<a id="use-this-package"></a>
## 使用本包

本包是仅限 macOS 的可选依赖。本地开发时运行 `pnpm --dir packages/experimental/cua-macos run build:native`，在 `native/bin` 下生成临时签名应用及 `current.json`。正式打包需要指定 `--identity "Developer ID Application: <name> (<team>)"` 并完成公证，参见[原生构建与服务](native/README.zh.md#build-and-service)。安装版保留分发时的签名。源码准备需要 Apple Command Line Tools 提供的 Swift 和 Python 3。

从仓库运行 Web 时，在插件页开启 [Computer Use](../cua-bundle/README.zh.md)。首次启用会在 macOS 14 及以上准备本机组件，Windows 支持正在开发中。现有 Web profile 保持选中时，后续构建继续检查更新。未开启的 profile 不准备原生组件。也可以显式加载源码覆盖层：

```sh
pnpm dsh headless --patch packages/experimental/cua-macos/examples/macos.cordis.yml --dump-config
```

配置输出命令不发起模型请求。执行真实任务时，将 `--dump-config` 替换为任务提示，并配置该 profile 的模型凭据。配置挂载 computer-use 注册表和本 provider；使用前需移除已有的竞争 provider。`DSH Computer Use.app` 需要辅助功能权限来读取 AX 和输入，需要屏幕录制权限来截图；按系统提示给 helper 授权。`getCapabilities` 查询权限和锁屏状态，不弹出系统授权窗口。桌面会话锁定或不可用时，界面观察与输入会在分派前拒绝，需由用户解锁 macOS 后继续。`listApps` 和 `cua.getState` 列出运行中的应用。`findApps(query)` 按名称、bundle ID 或绝对路径搜索 macOS 标准应用目录。`getApp` 按唯一名称、bundle ID、路径或运行中的 PID 选择应用，取得应用许可后，在需要时后台启动尚未运行的应用。授权前从磁盘读取应用的 Bundle ID 和可执行路径，在启动前后重新读取并核对；没有 Bundle ID 的应用使用规范化的可执行路径复用授权。选择尚未运行的安装副本时，会请求为该副本创建新实例。helper 等待应用完成启动后才返回其 PID。启动后验证失败会使待启动句柄失效，但进程可能仍在运行；应先查看运行中的应用，再取得新句柄。返回的对象读取初始 AX，不自动激活应用。启动被取消时，应用可能已经运行。模型指引要求先在后台观察和输入，不在初始化或每次动作前激活应用。窗口隐藏或最小化时，先尝试 `app.show()` 或 `window.show()`，再重新观察。它请求取消隐藏和恢复最小化，不主动激活、抬起窗口或切换桌面空间；应用级恢复选择焦点窗口、主窗口或唯一 AX 窗口。结果通过 `windowId` 指明选中的窗口，未选中时为 null；`foregroundChanged` 比较操作前后的前台应用和最上层窗口，无法取得完整观察时为 null，返回后仍可能发生焦点变化。恢复失败或窗口仍不可用时，说明需要前台的步骤，再调用 `app.activate()` 或窗口的 `raise` 动作并重新观察。必须使用前台时，以完成任务为先。应用收到输入后仍可能改变焦点，后台投递不保证用户操作始终不受干扰。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `agentPreset` | `ptc` | 仅为绑定该 preset 的 Agent 注册工具和指引；`false` 表示全局注册。 |
| `allowedApps` | `[]` | 旧路径和签名许可，只导入 profile 存储一次供撤销，不授予新 Bundle ID 身份访问权限。 |
| `helperPath` | 包内可执行文件 | 已签名 helper `.app` 内可执行文件的绝对路径；裸二进制会触发 `NATIVE_APPLICATION_REQUIRED`。 |
| `buildTimeoutMs` | `300000` | 原生组件准备的最长时间。 |
| `timeoutMs` | `30000` | 单次操作截止时间，取消后可能已发生部分输入。 |
| `connectTimeoutMs` | `5000` | 连接或启动共享 helper 的截止时间。 |
| `screenshotTimeoutMs` | `5000` | 截图总期限，包含排队时间，且不超过 `timeoutMs`。 |
| `axTimeoutMs` | `3000` | 每次 Accessibility 系统调用的截止时间，与完整操作截止独立配置。 |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 请求与响应字节限制。 |
| `maxClipboardBytes` | `33554432` | 粘贴时保存原剪贴板内容的字节上限；超限会在替换前拒绝。 |
| `pasteReadTimeoutMs` | `1000` | Paste 命令返回后等待剪贴板读取的上限；到期返回 `PASTE_NOT_CONSUMED`。 |
| `maxAppMatches` | `20` | 已安装应用搜索的结果上限；范围过大的查询会被拒绝，需要缩小名称范围。 |
| `maxElements` / `maxDepth` | `2000` / `25` | 辅助功能树遍历限制。 |
| `maxClickHoldMs` | `5000` | 显式点击按住时长的上限，单位为毫秒，接受非负整数。设为 0 时只允许立即松开。 |
| `dragDurationMs` / `dragSteps` | `400` / `20` | 拖动时长和移动分段数。 |
| `textEventIntervalMs` | `0.25` | 每个 Unicode 按下或抬起事件后的间隔，范围为 0 至 1000 毫秒。组合键的节奏独立。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-cua-macos)列出全部字段。原生工具调用使用 `{method, params}`，模型可以看到每个方法的完整参数定义。例如，`getApp` 返回 `listWindows`、`getState` 和输入操作所需的 `appHandle`。

数字键盘名称（`KP_0` 到 `KP_9`、`KP_Enter` 和数字键盘运算键）保留独立的物理键码。组合键用 `+` 分隔修饰键与按键。加号键写作 `+`，Command 加号写作 `cmd++`，也可以使用键名 `plus`；`cmd+` 这类缺少按键的输入会被拒绝。

Agent 销毁和插件卸载会取消并等待完整工具调用，包括图像接入检查和附件存储。已经开始的图像写入必须结束后，销毁才会返回；已取消的调用不会返回成功截图。

CUA 工具在读取 AX、窗口标题、截图、激活和输入前检查应用授权。首次选择应用时询问用户，可选择本会话允许、拒绝；profile 提供持久存储时还可保存长期授权。会话许可按对话和应用身份持久化，重启 DSH 或关闭 Computer Use 后仍可复用，其他对话需要单独授权。应用身份使用区分大小写的 Bundle ID，因此不同路径下的版本和副本共用许可与撤销决定，不受签名状态影响。运行中应用具有有效 Bundle ID 时，即使操作系统无法提供可执行路径，也可以授权。路径可取得时仍核对所选目标，进程实例和窗口归属检查始终保留。缺少 Bundle ID 时，授权必须取得规范化可执行路径。在同一路径下重启或更新会沿用许可，移动或复制到另一个路径则需要重新决定。这项规则不验证发布者身份，其他程序声明相同标识，或替换路径授权所对应的可执行文件时，也会继承许可。拒绝后，同一会话不会反复询问。撤销与长期许可的保存共用队列，在队列内读取并移除许可，然后使相关 Agent 连接失效并等待原生清理完成，不自动重放输入。同一 Agent 连接中的其他应用也需要重新选择，其他应用的会话许可和长期许可仍可复用。设计理由见[应用授权决策](../../../.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.zh.md)。这些检查的范围是 CUA 调用。persistent PTC 与已授权的 shell 仍按各自执行权限运行。

原始 `getState` 操作返回经过校验的状态字段，以及按本次披露选项生成的完整文本。原生 helper 还返回供原生检查使用的结构化元素诊断数组；工具投影会从模型文本和结构化工具值中移除这份重复数组。

AX 观察默认只展示菜单栏入口。使用 `app.getAXState({ includeMenus: true })` 展开菜单内容，使用 `app.getAXState({ details: true })` 读取标识符、全局 point 坐标和完整动作名。原始 `getState` 和 AX/截图组合观察也接受这两个选项。每次观察都会替换该范围的元素编号，展开后应使用新输出中的编号。详情不会绕过配置的节点数和深度上限；截断提示会指明触发的上限。

实际值与占位文字分别展示。有名称、状态或可用动作的分组和滚动区域保留独立行。同一节点中重复的名称、描述和帮助只显示一次。实际值、占位文字和 URL 即使文字相同也保留各自含义，不删除不同节点共有的正文。相关控件明确展示可写性，包括 `AXIncrementor`；`unknown` 表示系统未报告。缺少可选状态字段不代表 false。超出当前值长度的 UTF-16 选区标为不可用。自定义动作简称省略 AppKit 的 target/selector 诊断信息；同名动作需要使用 `details:true` 返回的完整名称。

观察方法默认自动输出，同时返回结果。在 persistent PTC 中使用 `void await app.getAXState()` 输出一次，或指定 `emit:false` 后自行打印一次。AX 输出后的截图可能单独失败，已成功取得的 AX 输出仍保留。

截图诊断使用带工具请求 ID 的 `[cua-screenshot]` 记录。原生阶段记录经本次 Agent 连接返回，覆盖窗口及 AX 几何检查、系统截图、PNG/Base64 编码和响应写出。Host 调试日志补充发送、响应和清理耗时。每次请求最多保留 8192 字节完整诊断记录，超限会明确标记；截图失败时附在错误中，保留到 Session trace。记录只含阶段、耗时和错误码，不含窗口标题、AX 正文或图片内容。

原生准备通过文件锁串行构建和签名，将完整应用保存在 `native/.build/prepared` 下的内容摘要目录中，再原子更新 `current.json`。旧连接继续使用原应用，相同构建复用已有文件，损坏的副本拒绝使用。取消或准备失败后，先完成受管进程清理再释放锁。

### 接入外部执行环境

使用 persistent PTC 时，在 macOS 配置后追加 `--patch packages/experimental/cua-macos/examples/persistent-ptc.cordis.yml`。该 provider 为存活的 Agent 保留变量，并遵守当前选择的文件沙箱策略。调用方导入适配模块，并提供当前执行中已授权的 `tools.cua` 绑定。persistent PTC 会在 CUA 指引中收到安装目录内 bridge 的文件 URL，项目无须安装本包。下面的例子用于能从自身安装目录解析本包、且已提供 `tools` 的外部宿主；本包不安装全局对象，也不负责保留变量：

```javascript
import { connectCua } from '@deepseek-ai/dsh-cua/bridge'
const cua = connectCua(() => tools.cua, text => console.log(text))
const app = await cua.getApp("com.apple.TextEdit")
void await app.getScreenshot()
```

单窗口任务直接使用 app 方法。`getApp` 已读取初始 AX，截图不需要枚举窗口或额外读取 AX。任务需要指定窗口或默认选窗存在歧义时，再调用 `app.getWindows()` 和 `app.getWindow(windowId)`，根据观察到的标题与位置选择目标。

`getWindow` 会输出初始 AX 树。已确认归属但没有 AX 界面的窗口返回空快照，仍可截图和发送坐标输入。不同窗口分别保留快照，读取一个窗口不会使另一个窗口失效；重新读取同一范围会使旧索引失效。观察期间节点被移除时，该次读取返回 `STALE_SNAPSHOT`，不发布部分树；可以重新读取，但不要重复此前的输入。应用级截图和坐标操作复用最近一次 AX 观察：优先使用其中在屏幕上且尺寸非零的焦点窗口，否则要求只有一个符合条件的窗口。它们不会重新查询即时焦点；需要跟随焦点变化时，先读取 `app.getAXState()`。显式窗口对象保持选定的目标。键盘方法保留在 `app` 上，因为输入跟随应用的当前焦点。

`hover(target)` 优先通过控件声明的 AX 动作展开替代界面，不移动系统鼠标。进入展开区域的子控件时保持父控件展开，离开后恢复默认界面。没有这条路径时，再将可见系统鼠标移到 AX 元素中心或窗口内坐标，不按鼠标按钮，也可用于禁用控件。所选应用必须在前台，且目标点未被遮挡，否则返回 `FOREGROUND_REQUIRED`，调用方需显式激活或抬起窗口并重新观察。调用结束、AX 读取和截图不恢复先前的位置。等待应用的悬停延迟后，观察出现的内容，再移入并点击；连续调用可经过中间位置。其他输入或应用自身变化可能中断交互。[连续交互的设计理由](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.zh.md)。

`paste(text, { format: "text" | "html" })` 临时提供指定格式的剪贴板内容，并调用应用已启用的标准 Paste 菜单命令。临时格式保留到剪贴板读取方请求其数据，然后只在仍持有剪贴板时恢复保存的全部原格式，保留期间产生的新复制内容。粘贴操作共用跨进程锁，取消会等待辅助进程清理。强制终止进程可能阻止恢复。应用不支持 Paste 命令时明确失败，不自动改成逐字输入；`typeText` 仍单独提供按键事件输入。

`selectText` 通过可写的 `AXSelectedTextRange` 选中唯一的字面文本，或把光标放在它的前后。紧邻的前后文用于区分重复文本。选区操作保留其余文字和格式，并核对实际 UTF-16 范围；控件不支持、文本不存在、匹配不唯一或文字变化时明确失败，不自动改用键盘输入。AX 文本包含可用的 `selectionWritable`、选区范围和选中文字。

截图要求附件服务可用，并确认当前模型支持图片输入。共享附件接入校验规范 Base64、图像数据及配置容量，然后保存一次图片。程序调用方仍可取得原生数据，模型内容包含坐标元数据和持久图片引用。响应字节上限在解析前执行。

hover、click、scroll 和 drag 的绝对坐标默认使用最近返回截图中的像素。传入 `relative: true` 时使用0～999 的千分比整数；省略或传入 `false` 时使用像素。相对坐标可基于成功的 AX 读取或截图，绝对坐标必须先截图。Host 根据实际送入模型的图片尺寸换算原生 point，包含附件归一化和模型请求阶段的缩放。999 映射到窗口边缘以内。坐标选项不适用于 AX 元素索引。窗口宽高与最近一次观察不同时，在输入前返回 `WINDOW_CHANGED`，原始调用即使不传快照 ID 也会检查；重新读取 AX 或截图后再操作。单纯移动窗口不使窗口内坐标失效。截图和鼠标输入会核对所选窗口的辅助功能框与显示边界；已知两者不一致时，在发送任何鼠标事件前返回 `WINDOW_CHANGED`。当 AX 保留完整窗口框时，这也会拦住 Stage Manager 变换后的窗口。需要重新读取状态；激活应用或抬起窗口仍须显式调用。元素声明的 AX 动作保持可用。缺少 AX 几何时保留无 AX 路径，不代表变换后的窗口一定可以操作。

保留的对象会在每次调用时获取当前工具绑定。外部运行时负责持久化、导入、取消和最终表达式值的序列化。截图返回编码字节及其 MIME 类型、像素尺寸和窗口 ID，标准工具链负责将图片作为附件传递一次。`emit: false` 只控制对象层的输出。使用其他分派器的宿主可以通过 `./api` 的 `createCuaApi` 创建对象。

AppKit sheet 可以通过其窗口 ID 单独选择，也会出现在所属文档窗口的控件树中。只有应用当前获得焦点的 sheet 指向唯一的 Apple 面板服务窗口，且该服务仍聚焦于同一面板时，键盘输入才转交系统打开或保存面板。无法确认或存在歧义的远端接收方会在输入前报错。

元素索引支持右键或中键单击以及左键单击、双击。点击和拖动选项可指定按键与修饰键；带修饰键的点击使用指针输入。拖动期间保持指定按键，并在移动和释放事件中携带修饰键。AX 文本标明禁用控件、`valueWritable=true` 和可读取的 `selected` 状态。不带修饰键的点击优先使用元素声明的辅助功能动作；需要发送鼠标事件时，会重新读取元素位置并核实所属窗口。动作返回只表示输入已分派。可视指针或点击标记可以独立绘制；AX 动作无需移动系统指针。窗口定向鼠标输入仍可能改变应用焦点、选区或对话框。输入后需要读取状态确认结果。`STALE_APP` 需要重新获取应用，`STALE_SNAPSHOT` 需要重新读取 AX。请求超时或取消会等待原生停止确认，保留仍可用的句柄；无法确认清理完成时关闭该 Agent 的连接。未返回系统回调的截图 RPC 占用唯一捕获槽位，新截图立即返回 `CAPTURE_BUSY`，AX 和输入仍可使用。迟到图片被丢弃，真实回调结束后释放槽位。只有操作无法停止或清理失败时，才可能使共享进程及所有旧句柄失效。不能自动重试结果不确定的输入。关闭 Agent 会释放其连接和 AX 引用，但不会撤销应用中的修改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>操作分派与资源归属</summary>

对象接口将应用和窗口方法转换为 JSON 操作。适配模块通过标准工具链保留授权、嵌套日志和图片接入。同一用户的相同 helper 构建由多个 Agent 和 Host 共享。每条连接独立保存句柄、快照、配置和取消状态，桌面操作通过全局队列执行。受管启动器将服务生命期交给这些连接，最后一条连接清理完成后服务退出。进程锁覆盖构建身份及真实可执行路径，防止重复启动或覆盖运行版本后产生路径冲突。原生句柄绑定进程身份及内核启动时间，快照中的 AX 引用只保存在辅助进程内。未来平台可以实现相同操作协议，无需在对象接口中加入平台逻辑。

[Zod 操作定义](../cua/src/protocol.ts)负责模型参数，并单独声明 Host 资源字段和内部续接操作。公共数据类型从这些定义推导。`pnpm exec tsx packages/experimental/cua-macos/native/generate-protocol.ts` 生成原生 JSON Schema 和 Swift 字段、枚举校验表；包测试检查产物是否同步，并验证模型不能提交 Host 专属字段。原生目标验证、资源上限和操作行为仍在执行处检查。

[AX 文本格式化](native/Sources/CuaNative/AXTextFormatter.swift)只接收已读取的节点数据。AX 遍历器独自分配索引并保存原生引用，格式化不维护另一套快照或目标注册表。

原生请求 ID 与工具日志中的调用 ID 一致。成功的激活和窗口抬起操作会在原始工具结果中保留前台操作信息，以及操作前后的即时焦点观察。应用已在前台时跳过重复激活；窗口抬起还要求该窗口正是焦点主窗口、未最小化且位于可见普通窗口的最前方，才会跳过。无法确认时保留原请求。这些观察不能确认其他焦点切换的发起者，也不代表操作已经完成。

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

插件提供一个 `cua` 操作工具，定义各方法的参数。标准 PTC 呈现通过 `run_code` 将它暴露为 `tools.cua`。以下是本包逐字输出的指导文本：

##### 操作指导文本（原文）

```markdown
Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps or cua.getState to discover running applications, and findApps(query) to search installed applications by name, bundle ID or absolute path. getApp requests user consent before launching a stopped application in the background, or before observations and input on a running one. If access is denied or revoked, stop using that application until the user explicitly permits another authorization request. Never switch tools to bypass a refusal. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. Raw getState returns AX text and snapshotId. Menu-bar entries are shown by default; includeMenus=true expands their contents. details=true adds identifiers, global-point bounds and complete action names. Both options also apply to getAXState. Each read replaces the indices for that app/window scope. Use its element indices only with that snapshotId. Raw screenshot and coordinate operations require a windowId. Coordinates are pixels in the latest returned screenshot, measured from its top-left. Set relative:true for integer thousandths from 0 to 999 instead. The Host converts both modes to native window points; AX detail bounds remain global macOS points. A verified window can expose no AX elements. Its empty snapshot permits screenshots and coordinate input; element-index actions require an element from a fresh AX observation.

Initialize the object API once in persistent PTC. Reuse its variables in later calls; put temporary declarations inside { ... } blocks to avoid redeclaration errors. All object methods are async. getAXState returns text, not a structured state object. Its text separates values and placeholders, and reports subroles, help, URLs, disabled/focused/selected/expanded state and UTF-16 selection ranges when available. Writability is true, false or unknown on relevant controls; omitted state fields do not assert false. selection=unavailable means the reported range exceeds the observed text. Compact output omits ordinary Press/Pick (click), ShowMenu (right click) and ScrollToVisible actions; details=true lists every available action. Use the displayed action name with performSecondaryAction; ambiguous aliases require the complete name from details=true. Truncation reports the reached provider limit. Narrow the window or increase that provider limit before reading again.

Use app methods directly for single-window tasks; getApp already reads initial AX state. Call app.getWindows() and await app.getWindow(windowId) only to target a particular window or resolve ambiguous window selection. App screenshots and coordinate actions use the latest AX observation: its focused on-screen, nonzero-size window, otherwise the sole such window. They do not refresh focus automatically. Read app.getAXState() to follow changed focus.

CuaScreenshot contains { bytes: Uint8Array, mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif", pixelWidth: number, pixelHeight: number, windowId: number }. Use mimeType to choose a file extension or declare an image; do not assume PNG.

Object API signatures (options default to { emit: true }):

- cua.getCapabilities(options?) -> { platform, permissions, sessionLocked, methods, coordinateSpace, browser }
- cua.listApps(options?) -> Array<{ id, displayName, isRunning: true, pid }>
- cua.findApps(query: string, options?) -> Array<{ id, displayName, path, isRunning, pid? }>
- cua.getState(options?) -> { apps, browsers: [] }
- cua.getApp(selector: string) -> App
- app.activate() -> { dispatched: true, verified: false }
- app.getWindows(options?) -> Array<{ windowId, pid, appName, title, bounds, isOnScreen, onCurrentSpace }>
- app.getWindow(windowId: number) -> Window
- app.typeText(text: string), app.pressKey(chord: string) -> action result
- app.paste(text: string, options?: { format?: "text" | "html" }) -> action result

App and Window methods:

- show() -> { dispatched: true, verified: false, windowId: number | null, foregroundChanged: boolean | null }
- getAXState(options?: { emit?: boolean, disableDiffing?: boolean, includeMenus?: boolean, details?: boolean }) -> string
- getScreenshot(options?: { emit?: boolean }) -> CuaScreenshot
- getAXStateAndScreenshot(options?) -> { state: string, screenshot: CuaScreenshot }
- hover(target: number | [x, y], options?: { relative?: boolean }) -> { dispatched, verified, hoverRoute, systemPointerMoved }
- click(target: number | [x, y], options?: { mouseButton?: "left" | "right" | "middle", clickCount?: 1 | 2, holdMs?: number, modifiers?: Array<"command" | "control" | "option" | "shift" | "fn">, relative?: boolean }) -> action result
- setValue(elementIndex: number, value: string) -> action result
- selectText(elementIndex: number, text: string, options?: { prefix?: string, suffix?: string, selectionType?: "text" | "cursor_before" | "cursor_after" }) -> action result
- performSecondaryAction(elementIndex: number, action: string) -> action result
- scroll({ x, y, deltaLinesX, deltaLinesY, relative? }) -> action result
- drag(from: [x, y], to: [x, y], options?: { mouseButton?: "left" | "right" | "middle", modifiers?: Array<"command" | "control" | "option" | "shift" | "fn">, relative?: boolean }) -> action result

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Keep applications in the background for observation and routine input. Do not activate or raise an app during initialization, before each action, or merely because another app is foreground. Prefer advertised AX actions. If a window is hidden or minimized, try app.show() or window.show() and read fresh state. show requests unhide and unminimize without activation, raising or switching Spaces; it chooses the explicit, focused, main or sole AX window. A null windowId means no window was selected for restoration. foregroundChanged compares the front app and top window before and after the request; null means unavailable, and delayed focus changes remain possible. If restoration is unsupported or the window remains unusable, including another Space or Stage Manager, explain the needed foreground step, use app.activate() or an advertised raise action, and read fresh state. Completing the task takes priority when foreground access is necessary. Avoid repeated activation when the user switches away; continue background-capable steps and report what requires foreground access. Applications may still change focus in response to input.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. Absolute coordinate input requires a fresh screenshot of that window. Relative input can use a successful AX observation or screenshot. SCREENSHOT_REQUIRED means capture a fresh screenshot before using pixel coordinates. For click and hover, coordinate targets must be [x, y], for example hover([650, 400], {relative:true}). A bare number such as hover(650) is always an AX element index. The relative option applies only to coordinate targets, not AX indices. Window resizing since the latest observation rejects coordinate input; movement alone preserves window-local coordinates. WINDOW_CHANGED requires fresh state before any retry; use an advertised AX action or explicitly restore the window before screenshot or coordinate input, then observe again. PERMISSION_DENIED requires the user to grant the required macOS system permissions for macOS Accessibility or Screen Recording. After granting access, observe fresh state before continuing; do not automatically replay prior input.

Hover first uses advertised AX alternate UI without moving the system cursor, preserving revealed descendants until the pointer target leaves their region. When unavailable, it moves the visible system cursor without pressing a button; that route requires the target point to be unobscured in the foreground app. FOREGROUND_REQUIRED requires explicit activation or raising and a fresh observation before retrying. Returning, AX reads and screenshots do not restore the previous point. Wait for the application's hover delay, observe, then hover into the revealed controls before clicking. Use successive hover calls for intermediate points. The result reports hoverRoute and systemPointerMoved. Other input or application changes can interrupt the interaction; app objects do not reserve applications between calls.

Use selectText only on controls advertising selectionWritable. It selects a unique literal occurrence, or places the cursor before/after it; prefix and suffix must be immediately adjacent. AMBIGUOUS_TEXT requires more context; TEXT_NOT_FOUND or SELECTION_CHANGED requires a fresh observation before deciding on input. Left clicks support single/double clicks; right and middle clicks support single clicks. Modified clicks use pointer input. Optional holdMs is a nonnegative integer in milliseconds for each press, including each press of a double-click. Zero releases without an additional hold. The configured maximum is stated below. It uses pointer input even for AX targets; omission preserves ordinary clicks. The operation deadline still applies, and cancellation or timeout releases the held button. Keypad names such as KP_0 and KP_Enter retain their physical key identity. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Paste follows the target app's focused text input. Foreground requirements vary by application; for example, ChatGPT/Codex was observed to accept background Paste without reading clipboard data. PASTE_NOT_CONSUMED means the command was dispatched but no clipboard read was observed before the configured deadline. Inspect the target contents, explicitly activate the app and focus the intended input, then observe again before deciding whether to retry; a delayed paste may still run. Original clipboard formats are restored if the clipboard still belongs to this paste; a later copy is preserved. Unsupported Paste commands fail without typing fallback. CLIPBOARD_CHANGED means another writer intervened; observe before deciding on further input. Browser applications can be controlled with getApp like other native apps; browser tabs are unavailable. Installed-app search covers standard macOS application directories; use an absolute application path for another location. Launch does not restore a window or document, and cancellation may leave an application already started. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, use the host-provided initialization snippet below once. Its installation-owned file URL works independently of the project directory. Retain app objects between calls. Observation methods emit by default and also return their value. Use void await app.getAXState() to avoid a duplicate REPL completion, or pass emit:false and print the returned text once. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.
```

#### Token 影响

启用插件会增加固定参数定义和指导文本。AX 观察、操作结果和已接入的图片会增加模型输入。本包不将保留的对象序列化进提示。

#### KV Cache 影响

工具结果追加到 Session 历史。修改插件配置或工具呈现方式可能改变请求前缀；保留应用对象不会改变已有历史。

## 已知限制与后续工作

队列只排序单次原生请求。持有 app 对象不会为 Session 保留应用，[连续交互](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.zh.md)不分配跨调用所有权。一直不返回的系统截图 RPC 会占用唯一捕获槽位，重新创建 app 对象不会重置该系统连接。

<a id="known-limitations-and-deferred-work"></a>

- 只提供 macOS 原生实现，Windows 支持正在开发中。本包暂放在 `experimental`，待 Windows 支持完成后迁回 `computer-use` 组。不支持浏览器标签、启动应用、AX 差分、无法确认应用归属的系统面板，以及仅后台辅助类型的应用。
- 坐标使用包含标题栏的返回截图像素；`relative: true` 使用 0～999 的整数，由 Host 换算原生 point。窗口移动、应用变化及其他桌面使用者的操作可能与观察和输入交错。
- macOS 台前调度可能将后台窗口的尺寸与截图变为缩略图，当前无法保证这种状态下的完整画面与坐标输入；模型指引要求说明前台需求并避免反复抢回焦点。
- 后台输入依赖私有 SkyLight 符号，macOS 升级可能使其不可用，需在目标系统版本验证。
- 实测 Blender Unicode 输入曾出现分派成功但界面未显示文本，后台 AppKit 的 Command+A 曾未选中全文。输入后必须检查应用状态；工具返回成功只表示已分派。
- 源码构建使用临时签名，源码变化后可能需要重新授权。正式分发应以固定 Developer ID 签名并完成公证；构建命令支持 `--identity` 指定签名身份，安装版保留分发时的签名。[权限页面](../cua/README.zh.md)提供 helper 授权入口和目标应用许可撤销。
- 发布打包不自动验证 GUI 启动、helper 身份或退出清理。发布维护者可在发布前，在已登录桌面的 Mac 上执行[分发 smoke](native/README.zh.md#build-and-service)；打包成功不能证明这些运行行为已通过验收。
- 已保存许可的条目显示一个已批准副本的名称、路径和图标，不枚举共享身份的所有安装副本。删除该副本后图标可能不可用，撤销仍作用于同一身份的所有副本。
- macOS 无法提供运行中应用的 Bundle ID 时，helper 仅在其报告的 bundle 可执行路径与实际进程路径相同时读取该 bundle，仍无标识则使用路径。只有 Bundle ID 和实际可执行路径均不可用时才拒绝生成授权身份；进程实例验证仍可能独立失败。
- 持久 PTC 是对外部运行环境的假设，本包不实现它。真实模型任务成功率需要在原生测试和协议测试之外单独评估。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
