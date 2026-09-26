# Agent Note: Windows 打开经 explorer.exe 完成

Status: implemented

[English](2026-09-22-windows-open-through-shell-resolution.md) | 中文

## 问题

Windows 桌面客户端设置页的「打开配置文件」会准备当前 profile 的 `cordis.patch.yml`，并把该路径交给原生文本编辑器打开器（issue #4428）。在报告者机器上，这个动作既没有打开窗口，也没有任何提示。打开器执行的是 `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '<path>'"`，因此由宿主进程内的关联解析决定结果，而 `Invoke-Item` 在解析不到应用时同样以退出码 0 结束。

该机器的 `.yml` 默认值只记录在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.yml\UserChoiceLatest`（progid 为 `VSCode.yml`），既没有 `UserChoice` 记录，也没有 `HKCU\Software\Classes\.yml` 默认值。对同一个文件双击，资源管理器会打开 VS Code。而在宿主进程中执行时，`Invoke-Item`、`cmd /c start`、`Shell.Application` 的默认动词和 `AssocQueryString` 都报告该扩展名没有应用，`cmd /c start` 则弹出 shell 自己的应用选择框而不是打开某个应用。`Invoke-Item` 仍然返回 0，于是 `SettingsController.openSettingsDocument` 回答 `{ opened: true }`，设置页不渲染任何错误。

## 决策

`openWindowsPath` 将路径作为**一个** argv 元素交给 `explorer.exe`，`revealNativePath` 经共享的 `runExplorer` 帮助函数走到同一个 shell。两者都把目标编码成文件 URI 并对**逗号与等号**做百分号编码，因为资源管理器自己解析命令行并以这两个字符分段——含其中任一字符的原始路径都会打开另一个目标且不作任何提示。其余字符不做转义：资源管理器会拒绝 file URI 里百分号编码的非 ASCII 并回落到「文档」，因此这些字符以字面形式交给它。资源管理器执行的是双击所执行的默认应用解析，因此由 shell 的答案选择应用——包括只记录在较新的按用户记录里的默认值；而完全没有处理程序的机器会得到资源管理器自己的「你要如何打开这个文件?」选择框，而不是毫无反应。

`runExplorer` 为两种操作持有唯一一条 Explorer 调用规则：退出码 1 是 Explorer 把请求转交给已在运行的桌面进程后返回的交接码，它照常兑现调用方的 Promise；其余失败和取消仍然报错。该帮助函数取代了 PowerShell 命令字符串，同时删掉了 `powershellLiteral` 及其单引号翻倍逻辑：路径以 argv 元素跨进程边界，去掉的是 shell 层转义，而不是资源管理器自身解析所需的编码；该编码由 `explorerTarget` 为两种意图统一持有。

Windows 对 HTML 与 SVG 仍然无法命名浏览器，因此 `openInBrowser` 继续拒绝该平台，默认意图、关联意图与文本编辑器意图都走同一个 Explorer 交接。

## 考虑过的替代方案

**继续使用 `Invoke-Item`。** 已否决。它询问的解析器与 shell 不同，因此即使某个用户的默认值能被资源管理器识别，仍会得到静默的无效操作；而且它的零退出码正好抹掉了设置页本应渲染的错误。

**在宿主进程内自行解析默认值。** 已否决。依次读取 `UserChoiceLatest`、`UserChoice` 和 classes 默认值，再启动胜出 progid 的 `shell\open\command`，等于重新实现一套 Windows 自己拥有的顺序，其中还包括 Windows 会校验的 `UserChoice` 哈希；而双击所用应用的定义就是 shell 自己的答案。

**使用 `cmd /c start <path>`。** 已否决。它为资源管理器本已执行的同一套解析引入一个命令 shell，并且在复现该缺陷的机器上同样报告没有应用。

**解析不到应用时回退到固定编辑器。** 已否决。Windows 安装总是带有可用的编辑器，但在打开器里选择它等于覆盖用户的关联，并把「缺少关联」变成「静默地打开错误应用」。

## 后果

设置页的打开动作与产物、工作区的打开动作共享同一个 Windows 行为：双击会启动的那个应用。对于「资源管理器认、`AssocQueryString` 不认」这一被报告的状态，现在会打开已配置的编辑器。

打开器再也无法区分「shell 打开了」与「shell 拒绝了」：两种情况 Explorer 都返回 0 或 1，因此 Remote 依旧回答 `{ opened: true }`，完全没有处理程序的机器只能看到 shell 的选择框。此处不校验窗口是否真的出现。

交互桌面会话现在是前提。在非交互 Windows 会话（服务，或没有交互登录的计划任务）中，`explorer.exe` 不调用任何关联，且同样以退出码 1 返回，因此该退出码无法与「已委派」区分：Windows 11 ARM64 build 26200 的 SSH session 0 实测约 1 秒后返回退出码 1，而同一会话里 `Invoke-Item` 命令能在进程内解析关联。这样启动的 Host 会失去能力且要付出等待，只有调用方的 abort 信号能给这段等待封顶。该会话下的兜底尚未实现。

目录走同一条路径。[open-in-app 记录](../feature/2026-08-25-promote-open-anywhere-plugin.zh.md)中被否决的方案是 detached 且经过凭据清洗的 `explorer.exe <dir>` 派生进程，那不是本交接的做法：`explorer.exe` 子进程继承宿主环境，也不创建 detached 进程；而它转交给桌面会话启动的应用或文件夹窗口，继承的是桌面会话环境而不是宿主进程环境。

## 验证

`path-opener.spec.ts` 固定两种意图交给 Explorer 的编码文件 URI、打开与选中都可接受的交接退出码 1，以及仍然报错的普通失败与取消。`resolver.spec.ts` 固定 open-in-app 路由在 Windows 上的命令。按该包测试策略，原生桌面验证留在 Windows。在 Windows 11 ARM64 build 26200 上，一次独立验证用 sha256 与源码一致的副本直接驱动模块自身的 `openNativeAssociatedPath`、`openNativePath`、`openNativeTextFile`，旁边挂一个记录 shell 实收参数的探针关联：每个含逗号的目标都以 `%2C` 完整到达、普通文件正常打开、名为 `dir,comma` 的目录打开为根目录正确的窗口。反证——同一个文件以逗号未编码的 file URI 交给 `explorer.exe`——没有触发任何关联、打开了用户的「文档」，而且**同样返回退出码 1**。因此退出码 1 记录的是委派而非结果，接受它不会把错误目标变成成功；真正保住路径完整的是那段编码。此处不观测窗口是否出现。同一 build 的后续一轮改为直接读取 shell 自己的窗口与选中状态：编码后的 `/select,` 目标选中了目标文件；未编码的 `=` 会打开「文档」而不是文件；非 ASCII 字符保持百分号编码时同样打开「文档」，改为字面字符则正常打开。
