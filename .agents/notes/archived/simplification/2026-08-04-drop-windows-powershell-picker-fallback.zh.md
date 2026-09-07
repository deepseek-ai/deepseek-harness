# Agent Note: 删除 Windows PowerShell 选择器回退

Status: implemented
Archived: 2026-09-04

[English](2026-08-04-drop-windows-powershell-picker-fallback.md) | 中文

## 问题

原生目录选择器的 win32 分支在 koffi `IFileOpenDialog` 子进程之下保留了一条两级 PowerShell 回退：先 `pwsh.exe`，再 `powershell.exe`（Windows PowerShell 5.1），两者运行同一个主动启用 `SetProcessDPIAware` 的 WinForms 脚本。该链的存在是为了在 koffi 层「不可用」时仍能给出一个可用的选择器，但它可能保护的每一个触发条件都是我们自己打包或部署的失败，而不是操作系统的：

- koffi 的原生二进制作为普通的可选 NPM 依赖（`@koromix/koffi-win32-x64`，无 install script）分发；能装上该包的宿主就一定有二进制，装不上的宿主会在安装期明确报错——回退代码也根本不会得到加载。
- 「上古 Windows」不可能出现：本仓库支持的 Node 版本运行在远比 Vista 时代 `IFileOpenDialog` ABI 新的 Windows 世代上。
- koffi/COM 缺陷只崩对话框子进程（crash isolation）；对我们自己 bug 的正确反应是上报失败，而不是静默降级到旧版对话框。

这条链还付出了真实的复杂度：两个 spawn 层运行同一脚本、把回退触发从 `ENOENT` 拓宽为 pwsh 的任何失败以修复 PowerShell 6（无 WinForms）回归问题、携带全部三个原因的三连败 `AggregateError`，以及每层的 abort 重检。seam 早已拥有唯一重要的回退——组合层面的 `browse` 后端，由 `directory-picker-auto` 在启动时选择一次。

## 决策

win32 层恰好就是 koffi `IFileOpenDialog` 子进程；任何失败原样上报，无回退。PowerShell 链——`pwsh` → Windows PowerShell 5.1 级联、DPI 修正的 WinForms 脚本、`AggregateError` 聚合——被删除，`pickNativeDirectory` 的 win32 分支成为单次调用。`dsh-native-command` 仍为 POSIX 层保留依赖。

本包其余部分早已遵循的回退判据现在统一适用：回退层只存在于操作系统/桌面环境提供且可能缺失的工具（Linux 的 `zenity` → `kdialog`，启动探针同样采样它们）；我们自己打包的工具（`koffi`）失败即明确报错。macOS `osascript` 与之前一样保持无回退。

本次变更合并并删除了 pwsh 优先的 DPI 选择器修复 Agent Note：其决策在此被完全反转，其保留的理由对只含 koffi 的层不再指导未来工作。其中真实的部分：PowerShell 7 呈现基于 `IFileDialog` 的现代文件夹选择器，而 5.1 的 `FolderBrowserDialog` 被硬连到旧版 `SHBrowseForFolder` 树；脚本的 `SetProcessDPIAware` 修正了 spawn 的系统 DPI 上限；pwsh→5.1 的跳转存在是因为可解析的 PowerShell 6 没有 WinForms（退出码 1，而非 `ENOENT`）。其被拒绝的替代方案（要求 PowerShell 7、导入 `resolvePwshPath`、在 harness 进程设置 DPI 感知）随链删除而失去意义。

## 考虑过的替代方案

**保留链但去掉 pwsh 质量层（`koffi` → Windows PowerShell 5.1）。**拒绝：剩下的层仍在防范我们自己打包的依赖发生故障，仍要付出脚本、拓宽的触发与聚合的代价，仍会把我们自己的 vtable/COM 缺陷藏到旧版对话框后面。「仅对外部提供的工具回退」的判据不接受任何 Windows 层。

**原样保留链。**拒绝：它是选择器中唯一的二级运行时回退，其触发条件是本就会明确报错的部署侧失败，并且它把一次失败的选择操作降级为 `AggregateError`，其中最具可操作性的条目却指向 PowerShell 宿主。

**原生 pick 失败时在运行时回退到 `browse`。**拒绝：seam 的流程洞属于 `single` 类型，`-auto` 组合已在启动时选择一个后端；运行时跨类型跳转会同时挂载两个后端并模糊能力边界。

## 后果

- win32 选择器的失败面是来自单一层的一个错误；调用方看到真实原因（koffi 加载失败、COM 拒绝、对话框崩溃），而不是链式聚合的错误。
- 本包不再调用 `pwsh`/`powershell.exe`；WinForms 脚本、其 `SetProcessDPIAware` 修正与 `-STA` 标志随之消失。
- 测试相应缩减：pwsh/5.1 级联与三连败用例被一个「失败原样上报、无回退」用例取代；默认适配器测试改驱动 Linux 层。
- 重新引入条件：未来出现在我们打包链之外的 win32 机制（我们不随包分发的系统提供的对话框宿主）才值得在同一判据下保留一层回退。
