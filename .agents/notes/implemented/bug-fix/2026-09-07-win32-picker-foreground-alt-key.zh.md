# Agent Note: 通过合成的 Alt 按键让 Win32 选择器获得前台激活

Status: implemented

[English](2026-09-07-win32-picker-foreground-alt-key.md) | 中文

## Problem

web GUI 宿主通过原生 Win32 文件夹对话框选择工作区目录，对话框运行在宿主 spawn 的子进程中（issue #3543）。Windows 只把前台授予前台进程、由前台进程启动的进程或最近收到输入的进程；后台服务器进程的子进程三者都不满足，因此 `Show` 打开的对话框即使属于子进程的首个窗口，也会落在所有可见窗口之后。spawn 设计背后的"首窗口即激活"假设（[归档功能记录](../../archived/feature/2026-08-02-win32-in-process-folder-dialog.md)）只在 spawn 链持有控制台前台时成立，例如控制台启动的 CLI。

## Decision

`runFolderDialog` 在 `showing` 通知与阻塞式 `Show` 之间调用新增的 `pressAltForForeground` 绑定。该绑定在对话框线程上合成一次 Alt 按键（`keybd_event` 携带 `VK_MENU`，先按下后抬起），使 Windows 把该进程计为最近的输入所有者——文档记载的允许前台激活的理由之一——于是 `Show` 创建的对话框窗口以前台方式激活。bindings 模块已经加载 koffi 的 `user32`，因此改动只增加一次函数获取与两次调用。该按键在 Windows 上无条件执行。当进程已经持有前台权利（控制台启动的 CLI）时，对话框本来就会激活，按键不起作用；此刻获得焦点的窗口仍会收到这一次单独的 Alt，可能短暂高亮其菜单栏。在合成输入被抑制的环境（安全桌面、受限远程会话、提权前台窗口）中，对话框仍会落在其他窗口后面，包 README 记录了该限制。

## Alternatives considered

**自定义 URL 协议加浏览器点击手势。** 草稿 PR #3544 通过让前台浏览器导航到已注册的 `dsh-picker://` URL 来授予前台，使 shell 把对话框进程作为前台进程的后代启动。该授权按设计具有确定性，但机制横跨注册表与 VBS 启动器文件、协议入口点、携带每次启动令牌的 picker-result HTTP 路由，以及首次使用时的浏览器确认，还增加了一条浏览器可达的服务端路由。合成按键删除了整个这一面。

**由点击方调用 AllowSetForegroundWindow。** 该 API 必须由当前前台进程——浏览器——调用，并且只能点名一个被允许的进程；spawner 无法代替浏览器调用它。

**对聚焦线程 AttachThreadInput。** 把对话框线程附着到焦点窗口所属线程同样能绕过前台限制且没有按键副作用，但同样没有文档契约，需要在显示时取得焦点窗口的线程 id，并在焦点窗口属于更高完整性进程时失败；未做原型验证。

## Consequences

选择器保持单一 spawn 子进程设计，并在后台宿主场景获得前台行为，代价是一次 koffi 调用对。bindings spec 在假 COM 世界上固定了 Alt 按下/抬起序列及其紧邻 `Show` 之前的位置；logic spec 固定完整的 showing → press → `Show` 顺序。Windows CI lane 仍会真实打开并中止关闭一个对话框（按键存在），但不断言激活。在一台把前台锁强制到最大值的 Windows 11 机器上做了验证：不加按键复现失败（对话框在其他窗口后面），加上按键后对话框获得前台，五轮重复全部成功；Windows 10 尚未验证。合成输入由 raw input thread 异步消费，因此激活授权原则上存在竞争窗口；重复运行中未出现错过，脆弱环境仍是记录的包限制而非第二套机制，因为浏览后端仍是原生选择不可信场景在组合层面的答案。
