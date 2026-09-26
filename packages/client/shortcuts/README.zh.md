---
description: "为每台设备自定义应用键盘命令"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-shortcuts

[English](README.md) | 中文

## 概述

为每台设备自定义应用键盘命令。桌面端和 Web 按接收输入的设备选择不同默认键位。自定义键位在同一设备重新加载后保留。命令随所属插件卸载而移除，保存的覆盖仍保留供重新安装使用。

Windows 在修饰键之间及第一个普通键之前使用 ` + `。Windows 和 macOS Desktop 上同时按下的两个普通键均并排显示，如 `F G`，提示和快捷键速查保持一致。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Web 应用 bundle 自动挂载此包。功能插件在 `ctx.effect()` 中通过 `ctx.shortcuts` 注册命令。每个命令为 `desktop:macos`、`desktop:windows`、`desktop:linux`、`web:macos`、`web:windows` 和 `web:linux` 显式声明默认值；省略的配置不绑定按键。服务接收物理 `code`，按设备展开 `primary`，并拒绝重复 ID 和任一支持配置中重叠的默认键位。同一可观察目录提供名称、键帽、已修改标记和键位冲突。命令 owner 在执行操作前解析当前目标。

功能插件通过 `registerFixed()` 贡献只读序列，通过 `observeFixedInput()` 观察局部控件处理后的输入。固定操作行随所属注册和语言变化；owner 可使用 `application` 展示分组，操作仍不可编辑。每个操作至少声明一个物理按键组合，不保存覆盖配置。这些组合参与冲突校验，不能分配给可编辑命令。Host 的 `stopSequenceMs` 配置控制连续两次 Esc 的最大间隔，默认为 500 毫秒，只接受 1 至 2,147,483,646 的整数，确保过期计时不超过浏览器定时器上限；页面加载时采用已校验的值。

偏好只保存覆盖：缺少命令表示继承默认，`null` 表示清除绑定，恢复默认则删除覆盖。全部恢复只影响当前运行端／平台配置。Web 使用同 origin 的 `dsh.keybindings.v1` 存储；Desktop 使用 Electron 设备本地的 `userData/keybindings.json`，与 Harness home 和工作区设置独立。其 schema 版本与 Session 数据无关。 macOS 和 Windows Desktop 读取版本 1 时不重写，在下次成功编辑时保存为版本 2；版本 2 增加可选的 `secondCode`。Web 和 Linux 保留原有绑定限制。

Windows 和 macOS Desktop 接受一至两个不同的受支持非修饰键，可搭配零至四个修饰键。双键绑定要求按住时间重叠，顺序不限；先后按键不匹配。仅含修饰键的绑定会被拒绝。同一修饰键集合下，单键与包含该键的双键组合冲突，包括固定操作占用的按键。已保存的绑定若与当前挂载的固定操作冲突，会保留显示但不能执行。包括 Command+C 和 Ctrl+C 在内的所有有效绑定优先于原生操作、编辑器、终端、内嵌页面和模态控件。录制和输入法组合状态仍受保护。只有两个键都按住时，双键组合才优先接管；第一个键仍正常处理，可能输入一个字符。

首次读取完成后激活键位。读取失败保留上次接受的配置；没有已接受配置时使用默认值。偏好不可读时，编辑和全部恢复均保持禁用。修复存储文档后重新打开应用；重置操作不会替换不可读或未来版本的数据。写入失败保留有效键位和草稿。其他浏览器标签页的更新使打开的草稿过期，保存前需要核对最新配置。浏览器写入前重新读取，但同时跨标签页写入仍采用最后一次成功写入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 构建在 Desktop 打包键盘集成之前生成 Node 入口和 `./protocol`；Client 阶段生成浏览器 bundle。

Windows 和 macOS Desktop 在局部处理器之前拦截已接受的完整组合，通过可信 preload 转发。所有平台的 Desktop 启动都要求原生键盘桥接。Windows 和 macOS 的可配置命令只由原生输入分发；DOM 输入继续交给固定操作。适配器仅拦截初次按下事件已被拦截的按键的松开事件。默认绑定与用户保存的绑定优先级一致，均优先于模态控件。其他环境在局部处理器之后分发，并遵守声明的区域。输入法组合、死键、AltGraph 和已消费的输入继续传递；macOS Web 可在输入法组合之外消费已绑定且报告为死键的 Option+Command+N，不保护后续输入。Web 和 Linux 的模态层阻止后台命令。已接管的重复事件仍被消费，但不重复执行。上下文携带原始 DOM 输入元素，包括 shadow root 内的元素。owner 同步解析目标，并负责操作错误。`ctx.shortcuts.closeWindow()` 统一持有 Desktop 键盘桥接，并携带当前已接受的 revision；Web 调用和桥接请求错误均返回失败。纯 `./protocol` 导出不依赖 React、DOM 或 Electron，在两个适配器间共享校验和串行持久化。显式覆盖取代冲突的新默认值；互相冲突的显式覆盖全部禁用。Desktop 拒绝过期版本，并将 IPC 限制在当前产品窗口和顶层 frame。适配器调用被拒绝时会记录日志并返回保存失败；发布已接受命令目录时的错误会向调用方抛出。

DOM 固定输入观察者在应用分发前收到输入法组合和消费标记。消费事件后，后续观察者和命令不能使用它。焦点、指针、窗口失焦、输入法组合、模态变化和局部停止传播会重置待完成的 DOM 序列。原生双键状态在窗口失焦、焦点 frame 或配置变化、输入法组合、录制和修饰键释放时重置。Electron 在原生拦截后可能省略 keyup；原生绑定完成时立即清空按住状态，因此每次触发双键组合都需要重新按下两个键。释放修饰键会清空按住状态，因为 macOS 在按住 Command 时可能省略字符键的 keyup。适配器释放时移除监听器和模态观察者；单个功能观察者失败不妨碍其他观察者接收输入。

Desktop 原生菜单和内嵌 frame 使用与 DOM 输入相同的命令注册表。Preload 和 Client 将获焦 iframe 的名称或浏览器 webview 租约与原生输入匹配；Client 拒绝旧配置消息。浏览器 guest 的输入监听在租约释放时结束，无需等待 guest 销毁完成。原生菜单选择是显式操作，不依赖快捷键绑定。双键组合没有原生菜单快捷键，其键位仍显示在快捷键速查中。Windows 和 macOS Desktop 之外的终端 Ctrl+W/R 保留为局部输入。显式原生菜单操作保留模态检查；键盘绑定使用对应设备的分发策略。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Web Client](../../../docs/subsystems/web-client.zh.md)
- [UI primitives](../ui-primitives/README.zh.md)
- [Web app bundle](../../bundle/web-app/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无；此包是浏览器侧 UI 插件，不注册面向模型的内容。

#### KV Cache 影响

无；此包不组装或发送模型提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 功能 owner 显式声明 Windows 和 macOS Web 的默认键位：Mod+Slash、Mod+Comma、Mod+Backslash 和 Control+Backquote 保持双键；其他不含 Alt 的默认键位使用 Mod+Alt，含 Alt 的使用 Mod+Shift，全屏除外，使用 Mod+Alt+Enter。macOS Web 的“刷新当前页”默认不绑定快捷键，以保留浏览器自身的 Command+Option+R 操作；刷新按钮和用户显式绑定仍然可用。Mod 在 macOS 上为 Command，在 Windows 上为 Control。Windows 和 macOS 的 Web、Desktop 均接受任意三个或四个不同修饰键的组合。Web 还接受上述组合及 Mod+Shift 组合；浏览器或系统能否送达按键需在对应平台测试。Linux Web 接受 Mod+Slash、Mod+Shift+Comma 和 Mod+Shift+Period。未送达窗口的操作系统快捷键无法被拦截。双键组合等待第二个键时，不延迟或消费第一个键；原生操作或焦点变化可能使组合无法完成。命令注册或注销会使打开的编辑草稿过期，即使保存的偏好未改变。Desktop 在每次命令目录更新时重新读取文件，不设置文件 watcher。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**Runtime invariant:** 不发布配套检查模块。目录和键位索引由私有注册表同步派生，没有独立维护、需要检查的运行时关系。
