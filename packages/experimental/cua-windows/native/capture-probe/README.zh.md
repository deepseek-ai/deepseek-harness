---
description: "使用系统安装的 .NET Framework 对比 Windows 截图方案，并审阅原生运行时迁移计划。"
---

# Windows 截图实验

[English](README.md) | 中文

## 摘要

无需安装 .NET SDK 或第三方库，即可对比屏幕复制、窗口 DC 复制和 PrintWindow。此私有实验以 .NET Framework 4.8 为目标，使用 Windows 已安装的编译器和程序集。它不替换提供方的截图实现。

## 目录

- [运行实验](#run-the-experiment)
- [解读输出](#interpret-the-output)
- [延伸阅读](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="run-the-experiment"></a>
## 运行实验

在交互式 x64 Windows 桌面上，从仓库根目录使用 Windows PowerShell 运行以下命令。演示创建两个临时窗口，测试可见的绿色目标，在遮挡后将其内容改为蓝色，然后将其最小化。完成后关闭两个窗口。

```powershell
powershell -NoProfile -File packages/experimental/cua-windows/native/capture-probe/run.ps1
```

打印的输出目录包含 PNG 和 JSON 测量结果。脚本在唯一临时目录中编译，运行后删除可执行文件。每次运行必须使用新的输出目录。编译错误、窗口不可用和截图失败均产生非零退出状态。

要对比自行选择的应用，传入其十进制顶层窗口 HWND 和新的输出目录。此模式捕获当前状态，不改变焦点、位置或可见性。可用窗口检查工具取得 HWND；PID 不是窗口句柄。

```powershell
powershell -NoProfile -File packages/experimental/cua-windows/native/capture-probe/run.ps1 -WindowHandle 123456 -OutputDirectory C:\Temp\cua-capture-example
```

替换示例中的 HWND 和输出目录。在窗口被遮挡、内容变化和尺寸变化后重复运行。屏幕复制的图片包含相应屏幕坐标上实际显示的内容；当其他应用可能出现在该位置时，证据应保留在本地。

-----

<a id="interpret-the-output"></a>
## 解读输出

每次截图在独立进程中执行，期限为五秒。卡住的截图会被终止，并记录为超时。JSON 记录 API 返回值、图片尺寸、截图耗时、采样到的前台变化以及已知标记颜色的数量。API 返回成功或生成有效 PNG，并不能证明图片包含目标的最新内容。

| 方法 | Windows 功能 | 检查内容 |
|---|---|---|
| `screen` | `System.Drawing.Graphics.CopyFromScreen` | 其他窗口是否替代了目标像素。 |
| `window-dc` | `GetWindowDC` 与 GDI `BitBlt` | 合成器承载的内容是否缺失或过时。 |
| `print` | `PrintWindow`，标志 `0` | 目标是否处理打印请求。 |
| `print-full` | `PrintWindow`，`PW_RENDERFULLCONTENT` | 是否包含完整、最新的客户区内容。 |

演示等待可见标记实际显示到屏幕后，再比较各方法。它在 MTA 线程读取 UI Automation，并将结果记入 `runtime.json`。标记检查适用于自有测试窗口；其他应用需要与实际状态进行视觉比较。本实验不测试 WGC、剪贴板恢复、输入、服务共享或 ARM64 兼容性。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [提供方行为与桌面验收](../../README.zh.md)
- [PrintWindow 及其同步执行](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)
- [Windows SDK 截图标志](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/WinUser.h)
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [.NET Framework 系统要求](https://learn.microsoft.com/en-us/dotnet/framework/get-started/system-requirements)
- [Code Pack 窗口截图源码](https://github.com/aybe/Windows-API-Code-Pack-1.1/blob/master/source/WindowsAPICodePack/Shell/Taskbar/TabbedThumbnailScreenCapture.cs)

-----

<a id="dev-note"></a>
### 开发备注

以下调研和拟议工作不是正式约定；生产 helper 仍以 .NET 10 为目标，并通过 WGC/Direct3D11 截图。

2026-10-20 使用的 Windows x64 机器安装了 Framework 版本标识 `533509`（4.8.1）。仅依赖 Framework 的探针已完成编译，通过 `System.Windows.Automation` 查询自有窗口并截图，无需 NuGet 依赖。当前自包含生产 helper 约为 192 MiB；探针小得多，因为它只实现本实验。其大小不能用来估算完整移植的大小。

对于完成绘制的 WinForms 测试窗口，四种方法均捕获了可见的绿色内容。遮挡窗口并将内容改为蓝色后，屏幕复制返回紫红色遮挡窗口，窗口 DC 复制和两种 PrintWindow 模式则返回新的蓝色内容。最小化后，各 API 都报告成功，但仅返回不含内容标记的 314 × 50 图片。这些结果不能证明其他渲染引擎或显示器上的行为。

对于 Edge 中的自有本地 HTML 页面，窗口 DC 复制和普通 PrintWindow 即使在窗口可见时也返回黑图。完整内容模式的 PrintWindow 捕获了可见的绿色页面。遮挡后，JavaScript 将背景改为蓝色并更新标题；完整内容模式捕获了更新后的标题，但客户区仍为旧的绿色内容。此场景的内容新鲜度要求尚未解决，包括 WGC 是否有不同行为。这说明替换后端前需要比较不同渲染引擎。

截图选型必须保留后台窗口观察能力。`CopyFromScreen` 和桌面复制读取合成后的桌面，因此不能替代遮挡窗口截图。DWM 缩略图在目标窗口中显示另一窗口，而不直接返回 PNG 像素。WGC 的接口本身就提供 Direct3D11 帧；删除 Vortice 包装库并不能消除该 API 的此项依赖。

Windows API Code Pack 可用于参考 Shell 对象、链接、通用对话框和任务栏集成。其 `TabbedThumbnailScreenCapture` 封装了 GDI 窗口 DC 复制，并明确说明隐藏或遮挡控件的限制。它不提供 WGC 或确认目标消费剪贴板数据的通用替代品。WinForms 已提供普通剪贴板访问、绘图、图片和消息循环；UI Automation 也属于 Framework。只有在具体能力能删除更多自有维护代码时，才引入 Code Pack 依赖。

拟议实现顺序：

1. 在 Chromium/Electron、WPF、传统控件、遮挡后的内容变化、混合 DPI 及卡死目标上，对比 PrintWindow 完整内容模式与 WGC。将保存的 PNG 与实际状态放在一起。完成对比后再选择生产后端；窗口截图失败时不得静默改用屏幕像素。
2. 将 .NET Framework 4.8 作为 x64 运行时移植候选，保留 `System.Windows.Automation`、WinForms、`System.Drawing` 和 Windows P/Invoke。单独验证 ARM64 运行时及交付要求；本次 x64 实验不能证明它们。
3. 明确迁移运行时 API：命名管道和互斥量访问控制、取消和释放、散列及 JSON 处理。Framework 的 `JavaScriptSerializer` 可以输出探针的 JSON，但替代 `System.Text.Json` 必须保留协议校验、重复属性拒绝、数字限制和转义行为。`JsonSchema.Net` 有 netstandard2.0 产物；当前 Vortice 版本只有现代 .NET 产物。避免仅为删除一个依赖包而手写 JSON/schema 框架。
4. 在所选运行时上执行自有桌面验收和共享服务生命周期检查，再更新源码准备和打包。检查通过后删除被替代的实现与依赖。此 Windows 运行时改动不扩展到共享 `cua` API 或 macOS 提供方。

当前桌面验收发现远程桌面客户端会在选定编辑器消费前预读剪贴板。待验证的修复会确认请求窗口所属进程，并为其他读取方继续延迟提供该格式。未携带 HWND 打开剪贴板的读取方无法归属，将超时。修订后的原生二进制已通过交叉编译，但本机 Smart App Control 阻止了它执行。分支交由用户在已获准的签名构建或测试环境中完成 Windows 验收。不能把此前的验收结果视为对该二进制的验证。
