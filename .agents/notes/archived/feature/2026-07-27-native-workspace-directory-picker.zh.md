# Agent Note: 原生工作区目录选择器

Status: implemented
Archived: 2026-09-04

[English](2026-07-27-native-workspace-directory-picker.md) | 中文

## 问题

桌面端 GUI 在添加现有工作区时要求用户输入绝对路径。相比使用操作系统原生选择器选取目录，这种操作速度更慢，也更容易出错。GUI 由本地 Web 载体提供，因此打开原生对话框也会形成一条特权边界，普通远程请求不得越过这条边界。

## 决策

新增一个用于选择单个文件夹的 `host.pickDirectory` RPC，并通过 `WorkspaceRuntime` 暴露该 RPC。工作区菜单提供平铺操作 **添加工作区…**（本决策做出时是两个操作：**打开本地文件夹…** 与一个按名称创建的入口，后者已被[单一路径 Note](../simplification/2026-07-31-one-route-to-add-a-workspace.zh.md)删除）。选定文件夹后，系统复用现有的 `workspace.create({ path })` 流程，选中返回的工作区，并启动一个空白会话。

工作区管理器必须在选择回调运行前插入或更新返回的工作区。因此，新纳入的目录会立即显示其 basename。再次打开已注册的路径时，则保留该工作区现有的标题。

## 交互约定

- 在 macOS、Windows 和 Linux 上，选择器一次只允许选择一个目录。
- 取消系统对话框不会显示提示，并返回 `null`。
- 路径重复时，选中现有工作区。
- 即使派生显示名与另一个 Workspace 相同，不同 canonical path 也会被收编为独立 Workspace（见[身份决策](../bug-fix/2026-07-31-same-basename-workspace-adoption.zh.md)）。
- 选择器的其他故障会显示简洁且可重试的错误提示。
- 本决策当时未触碰的按名称创建流程现已删除；选择目录就是添加工作区的全部（见[单一路径 Note](../simplification/2026-07-31-one-route-to-add-a-workspace.zh.md)）。

## 宿主边界

只有来自回环套接字、且携带同源浏览器元数据的请求才能调用原生对话框 RPC。该 RPC 不使用默认的 30 秒请求超时，因为系统对话框可能无限期保持打开；调用方中止或连接中止仍会传递至平台进程。

平台适配器不经 shell 打开对话框——POSIX 上 spawn 原生工具，Windows 上进行进程内 COM 交互：

- macOS：`osascript` 和系统文件夹选择器。
- Windows：koffi `IFileOpenDialog` 子进程，使用宿主接受的最佳线程 DPI 感知（可用时为 per-monitor-v2；不支持 PMv2 的主机级联到 per-monitor 或 system-aware）（见[进程内对话框 Note](2026-08-02-win32-in-process-folder-dialog.zh.md)）；该层无回退——失败原样上报（见[PowerShell 链删除](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.zh.md)）。
- Linux：使用 `zenity`；Zenity 不可用时回退到 `kdialog`。

## 考虑过的替代方案

- 自定义目录浏览器会重复实现操作系统的行为和权限逻辑，而且应属于 Web 实现，而非本次仅面向桌面端的变更。
- 继续使用手动路径字段会保留当前容易出错的交互方式。
- 为一个本地原生对话框添加身份认证基础设施，会使变更范围超出其威胁模型；对当前载体而言，回环与同源检查已经足够。

## 后果

当前 GUI 可以在 macOS、Windows 和 Linux 上通过原生选择器打开一个本地文件夹。取消操作不会改变任何状态，故障仍可重试；重复路径的处理具有幂等性，basename 相同的不同路径则可作为独立 Workspace 共存。选中的工作区及其显示名称会在启动新的空白会话前完成刷新。该选择器现已是获得工作区的唯一路径（见[单一路径 Note](../simplification/2026-07-31-one-route-to-add-a-workspace.zh.md)）：操作者要么选一个已有目录，要么在选择器内新建一个。

新增的宿主、运行时、组件和 GUI 测试覆盖原生边界、请求信任校验、取消与故障处理、已有路径复用、同 basename 路径收编和可见名称即时更新。该特权 RPC 仍仅面向本地桌面载体；远程 Web 目录浏览器不属于本次决策范围。

## 风险

- Linux 桌面环境可能不提供任何一种受支持的选择器。GUI 会报告这项限制，而不会回退到要求用户输入路径。
- 在受支持的本地载体之外，浏览器元数据可能有所不同。对于无法证明其满足所需本地同源上下文的请求，该端点会按设计拒绝。
