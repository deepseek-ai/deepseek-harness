---
description: "复用 Computer Use 应用和窗口对象，通过已授权并记录日志的平台操作完成任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cua

[English](README.md) | 中文

## 概述

检查应用、跨 PTC 调用保留窗口对象，并通过正常工具执行链发送动作。平台提供方负责原生执行；本库负责对象 API、请求校验、应用授权和图像接纳。变量持久性由外部 PTC 运行时负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

应用授权从 `src/locales.ts` 提供中英日展示文案。它使用 User Questions 的固定审批呈现，仍独立于会话的工具审批策略。本机图标用于授权提示和权限页展示，不进入保存的身份信息或模型结果。系统权限、持久授权与拒绝记录、图标分别查询，各项结果返回后即可显示。

-----

<a id="use-this-package"></a>
## 使用本包

挂载 [macOS 提供方](../cua-macos/README.zh.md)以启用原生操作。外部 PTC 宿主从 `@deepseek-ai/dsh-cua/bridge` 导入 `connectCua`，并提供当前 `tools.cua` 绑定。源码组合与原生组件准备由提供方负责。

单窗口任务直接使用 App 方法。`getApp` 读取初始辅助功能状态；需要指定窗口时使用 `getWindows` 和 `getWindow`。重新读取一个应用或窗口范围会替换其中的元素编号，不使其他窗口的快照失效。键盘输入跟随应用焦点。请求参数校验失败时，在分派前返回包含方法、参数和要求的可读消息。

观察方法会输出并返回结果。使用 `void await app.getAXState()` 只展示一份内容，或使用 `emit:false` 后打印一次返回文本。截图返回包含 `bytes`、`mimeType`、`pixelWidth`、`pixelHeight` 和 `windowId` 的 `CuaScreenshot`，图片输出回调接收同一个对象。选择文件后缀或声明图片时使用其中的 MIME 类型；格式可能是 PNG、JPEG、WebP 或 GIF。每张截图只进入一次附件处理链；`emit:false` 只抑制对象层的输出。

`tools.cua` 直接返回操作结果。截图结果保留图片 Base64，并增加供工具渲染使用的持久 `attachment` 引用；模型内容只包含坐标元数据和一张图片，不包含编码字节。截图前要求附件服务可用，并确认当前模型支持图片输入。图片接入或保存失败会拒绝调用。对象桥接保留截图字节和已校验的元数据，不重复上传或输出同一张图片。

应用授权发生在启动、观察、截图和输入之前。会话许可按会话和应用身份保存在内存中，Agent 或 helper 重建后仍可复用，重启 DSH 或关闭 Computer Use 后失效。长期许可要求平台验证可执行文件身份。拒绝或撤销会关闭受影响的 Agent 连接，因此旧对象必须重新选择目标。取消、超时或重新连接后均不重放输入。

动作返回 `dispatched:true, verified:false`；请读取新状态以验证结果。坐标操作默认使用最近返回截图中的像素；成功观察窗口后，传入 `relative: true` 可使用 0～999 的整数坐标。数值除以 1000 后按窗口尺寸缩放，并限制在窗口内。Host 在返回截图前解析附件归一化和当前模型的图片缩放规则，再将输入换算为原生窗口 point。窗口尺寸变化会使截图映射失效，绝对坐标遇到 `SCREENSHOT_REQUIRED` 时需要重新截图。窗口缩放后以 `WINDOW_CHANGED` 拒绝旧坐标；单纯移动窗口不改变窗口内坐标。

`click(target, { holdMs: 800 })` 按住鼠标按钮 800 毫秒后松开。`holdMs` 接受非负整数，双击时应用于每次按下；0 表示按下后立即松开，不额外等待。提供方配置 `maxClickHoldMs` 限制显式按住时长，默认 5000 毫秒。指定时长后，AX 索引和坐标目标都使用鼠标事件；省略时保留普通点击行为。按住时间计入操作超时，取消或超时会松开按钮。已接收的输入无法撤销；辅助进程被强制终止时无法保证松开。

### 权限控件

[Computer Use 组合](../cua-bundle/README.zh.md)将本页与原生 provider 一起挂载。“给 Computer Use 授权”把新会话默认模式、PTC 执行方式、辅助功能和屏幕录制放在同一个边框内，四排之间使用分隔线。两条系统权限要求在能识别责任应用时，把该应用的 `.app` 包名称和图标放在同一个标签中。“管理 Computer Use 可访问的应用”使用独立边框包住应用列表。点击“申请权限”，在 macOS 权限列表中找到该应用并开启对应开关；若 macOS 显示其他名称，以系统提示为准。来源无法识别时，页面引导用户查找系统提示的应用。每条系统权限要求只显示一个控件：未授权时为“申请权限”，已授权时为带设置图标的“已允许”描边按钮，点击直接进入对应隐私设置页，由用户撤销权限，悬停提示“打开系统设置”。无法确认状态时使用同样的按钮，文字为“未确认”。首次查询期间保留一个占位。进入详情页、返回窗口或完成授权操作后会自动刷新；查询失败时可点击“重试”。若系统要求退出并重新打开应用，请按提示操作并重新启动 DSH。

系统权限操作作用于运行 DSH 的电脑。远程访问时，请在该电脑上完成授权。

从插件列表启用后，系统权限尚未就绪时会显示设置引导，提供“稍后”和“前往设置”。从详情页启用后直接显示权限控件。详情页的“新会话默认模式”提供“设为 PTC”按钮，仅点击此按钮才保存默认值。已有会话保留原 preset。“PTC 执行方式”一行的“设为持久化”单独保存 `ptc-runtime.executionMode: persistent-in-memory`。切换会重载共享 PTC 执行器，可能打断当前调用；后续调用在内存中保留变量和应用对象。已经使用持久化模式时，按钮显示“已设为持久化”并禁用。

页面展示“始终允许的应用”和“不允许访问的应用”。后者汇总任一会话的拒绝记录，不取消其他会话已有的授权，也不阻止新会话询问授权。会话授权仍在对应会话中生效，详情页不展示这类应用。“撤销”会移除对应应用的访问许可并取消相关操作。已发送到应用的输入无法撤回，继续操作前需重新观察应用。“允许再次询问”清除该应用在所有会话中的拒绝记录；下次选择应用时仍需用户重新决定。

本插件没有配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>共享执行与平台职责</summary>

权限 Remote 还通过 `ptcConfiguration()` 和 `enablePersistentPtc()` 支持详情页的执行方式设置。查询读取现有执行器和可编辑的 profile 条目。显式写入使用 `configEditor.edit()` 保留其他字段并按正常 Loader 规则重载；已是持久化模式的执行器保持不变。此设置独立于系统权限和应用授权。

提供方将准备好的 helper、连接工厂和指引传给 [installCua](src/index.ts)。[NativeClient](src/native-client.ts) 负责请求关联、字节上限、取消确认和失败处理。平台连接器负责启动和连接清理。共享执行器为每个 Agent 保留一个连接，并在销毁时等待进行中的图像写入。

`agentPreset` 默认为 `ptc`，将工具和指引限制到绑定该 preset 的 Agent。提供方使用现有 `agent/created`、`agent-preset/selected` 事件及 Agent 拥有的作用域，也处理启用前已存在的 Agent。提供方卸载和 Agent 销毁都会释放这些注册。preset 定义可以晚于提供方注册；名称用于筛选已绑定的 Agent，在匹配的 Agent 出现前不提供工具。不使用 preset 的独立组合可设置 `agentPreset: false` 来全局注册。Host 仍拥有权限、本机连接和取消操作，preset 定义保持不变。

[操作 schema](src/protocol.ts) 定义模型参数，并单独声明 Host 专用字段。原生实现在执行时检查目标身份、窗口几何、资源上限和操作系统访问条件。本库没有独立投影的注册表或持久状态，因此不发布 invariant 模块。


根 Host 入口导出 `installCua`、`CuaConfig` 和供 Typert 发现的 `CuaAccess` 服务，`apply()` 只标记可选 Client 贡献。`/client` 通过现有模块加载器加载权限界面。Host 和 Client 使用独立编译项目，headless 导入不会加载 React、CSS 或浏览器注册。`/api` 提供应用、窗口 API 及其类型；`/bridge`、`/native-client` 和 `/protocol` 保留运行时和平台消费者。`/types` 仅导出生成 Remote 声明所需的四个命名类型，Client 使用包内类型。`/typert` 提供 Host 反射，`/remote` 提供浏览器描述和编解码，权限判断仍由 Host 执行。

可选浏览器插件挂载原生 provider 的权限 Remote，复用插件页的启用引导和配置插槽。四排使用条件始终可见，未加载的字段保留占位；查询期间和权限已允许时显示相同的权限管理说明，换行也不会改变内容。默认模式、执行方式、系统权限、应用列表和应用图标分别查询，结果返回后各自显示。应用名称和操作按钮不等待图标，图标位置保留空位。用户操作按顺序执行，不等待尚未完成的查询；卸载时等待操作和查询全部结束，再释放独立持有的 Remote 挂载。已知查询错误和只读设置提示在管理操作或重试期间保持可见，操作按钮禁用。查询错误只显示在对应部分，启用引导只等待系统权限结果。注入层独立于页面观察插件管理操作。组合包和组件行变更会暂停四项查询，并使进行中的结果失效；操作结束后即使页面已关闭，也会重新查询。已知错误保留至读取成功；卸载后的迟到结果会被丢弃。控制器直接接收生成的 `ctx.remote.cuaAccess`，在现有查询和操作流程中处理失败响应，并把查询结果投影到页面和设置弹窗；重新连接或 Host 返回的配置 namespace 更新时刷新状态。操作提示挂载到 shell overlay，关闭页面后仍可显示。provider 负责权限检查、持久授权和取消；浏览器不保存授权决定。

详情页通过现有 `configForms` 服务读取实际默认值（`selectedDefault ?? default`）。默认模式按钮仅写入 `selectedDefault`，沿用表单带版本检查的设置写入流程。执行方式一行调用 CUA 的 `ptcConfiguration()` 和 `enablePersistentPtc()`：Host 通过现有配置编辑器仅修改 `ptc-runtime.executionMode`，保留普通 Loader 重载规则。权限检查和执行方式状态独立返回。设置仍在加载、只读或不可用时不能提交；写入失败时在设置旁显示错误，供用户重试。
</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [macOS 提供方](../cua-macos/README.zh.md)
- [对象接口](src/types.ts)

-----

<a id="model-experience"></a>
## 模型体验

### 已授权的应用操作

#### 模型可见内容

平台提供方挂载共享的 `cua` 工具并提供操作指引。调用和观察使用同一套应用与窗口接口，进入正常 Session 历史。平台指引见 [macOS 提供方](../cua-macos/README.zh.md#model-experience)。

#### Token 影响

操作结果和接纳的图像增加模型输入。保留的 JavaScript 对象不会序列化进提示词。调用方重复打印会重复观察文本。

#### KV Cache 影响

结果追加到历史。保留对象不重写已有消息；更改挂载的工具或指引可能改变请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 会话授权决策保存在内存中，没有容量上限或淘汰机制，直到提供方卸载才清空。长期运行的 Host 会保留每个曾请求访问的会话与应用组合。
- 当前原生执行使用 macOS 提供方。Windows 支持计划使用独立的提供方包和 C# helper，保留共享应用与窗口 API、授权、快照有效性和动作结果语义。实现须说明系统特有的限制，并区分交叉编译证据和 Windows 桌面验证。
- 持久变量不会在一组连续操作期间独占应用。其他 Agent 和用户可能改变其状态。 悬停和观察不恢复先前的鼠标位置；[连续交互](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.zh.md)不分配跨调用所有权。
- 本包保留在 `experimental`，Windows 支持和平台验证完成后可迁至 `computer-use` 组。

-----

<a id="dev-note"></a>
### 开发备注

无。
