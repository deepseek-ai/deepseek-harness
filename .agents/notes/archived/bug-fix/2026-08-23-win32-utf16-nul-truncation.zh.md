# Agent Note: Win32 目录选择器路径不再在 U+XX00 码元处截断

Status: implemented
Archived: 2026-09-04

[English](2026-08-23-win32-utf16-nul-truncation.md) | 中文

## 问题

`packages/host/directory-picker-native/src/win32-dialog-bindings.ts` 的 `readUtf16` 用 `bytes[end] !== 0` 扫描 `IFileOpenDialog` 结果缓冲区来寻找零字节。UTF-16LE 真正的 NUL 是两个零字节，因此任何低字节为 0 的 BMP 码元——U+XX00，例如「开」(U+5F00)——都会提前结束扫描。选择 `C:\Users\XIAOPAN\Desktop\安卓开发` 这类目录会得到 `C:\Users\XIAOPAN\Desktop\安卓`，随后创建工作区的调用以 `workspace-invalid-path ... ENOENT` 失败。

## 决策

扫描只有在一个码元的两个字节都为零时才结束，仍按每次两个字节在同一个 32KiB `koffi.view` 缓冲区上推进。回归测试通过既有的假 koffi COM 世界驱动 `readUtf16`，路径包含「安卓开发」(U+5F00)，从而不依赖真实 Windows 主机验证终止规则。

修复逐字采用 ericcaiwx-star fork 的 `fix/win32-utf16-nul-truncation` 分支上的社区补丁系列——[c8aac14703](https://github.com/ericcaiwx-star/deepseek-harness/commit/c8aac14703a517b8db1573f9ca4ed94dc58e276b) 是扫描修复，[e1d6265cb9](https://github.com/ericcaiwx-star/deepseek-harness/commit/e1d6265cb930a0a74cba03c40e73ed872a83575f) 是 fixture 清理——在 [discussion #580](https://github.com/deepseek-ai/deepseek-harness/discussions/580) 报告（更早在 [discussion #563](https://github.com/deepseek-ai/deepseek-harness/discussions/563) 报告）。两次 cherry-pick 均保留原作者 ericcaiwx-star；上游 fork 是补丁的记录来源。

## 考虑过的替代方案

**拒绝社区补丁，本地重写扫描。** 拒绝：补丁极小，与目录选择器现有测试方式一致；逐字节一致的 cherry-pick 保留来源与署名。

**用 `toString('utf16le')` 解码整个缓冲区再按 `\0` 切分。** 拒绝：复制整个缓冲区而非扫描，且切分仍依赖同一「双零字节」规则。

**向 COM 或 koffi 索取字符串长度。** 拒绝：绑定面不提供长度；双零扫描是标准的 UTF-16LE NUL 判定。

## 后果

- 任何含 U+XX00 码元的路径组件都能通过选择器转译；含这类字符的路径（例如中文目录名）可以选中并用于创建工作区。
- 修复不改变 ABI 用法、缓冲区大小或对话框流程；[Win32 目录选择器 note](../feature/2026-08-02-win32-in-process-folder-dialog.zh.md) 中的 COM 子进程架构不受影响。
- 真实对话框渲染与选择仍是手动 Windows 检查；本次回归测试只针对假 COM 世界中的字节到字符串转译。fixture 路径为合成路径（`C:\fixture\安卓开发`），仓库中不出现真实用户路径。
