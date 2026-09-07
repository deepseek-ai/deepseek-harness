# Agent Note: 不用固定长度的非托管视图读取 Win32 选择器路径

Status: implemented

[English](2026-08-31-win32-picker-path-string-read.md) | 中文

## Problem

Win32 选择器需要解码 `IShellItem::GetDisplayName` 分配的 NUL 结尾 UTF-16 字符串，并通过 `CoTaskMemFree` 释放它。固定长度的外部 ArrayBuffer 增加了运行时要求和手工终止符扫描，却不能提供实际分配大小。

## Decision

`readUtf16` 将原生地址存入指针宽度的缓冲区，再交给通用 `koffi.decode(buffer, 'str16')`。通用解码需要指针变量，而非直接传入字符串地址。切片长度取自 `koffi.sizeof('void *')`；Koffi 3 用 BigInt 表示原生地址。解码期间分配必须保持有效且以 NUL 结尾。转换成功后，原始地址仍可交给 `CoTaskMemFree`；若解码抛错，字符串不会被释放。

## Alternatives considered

**外部视图加手工扫描。** 这要求运行时支持外部缓冲区，并重复实现 Koffi 的字符串转换。固定视图和递增分块都无法确定原生分配大小。

**字符串类型出参。** `_Out_ str16 *` 返回文本，却丢失显式 COM 释放所需的指针。内置 `str16!` 使用 CRT 分配器释放，而非 COM 分配器。

**自定义可释放类型。** Koffi 可释放类型可以调用 `CoTaskMemFree`，但显式转换无需注册原生类型，就能将地址和释放保留在同一调用点。

## Consequences

真实 Koffi 测试使用存活的 UTF-16 缓冲区执行生产结果路径转换，涵盖 U+5F00、代理对、NUL 终止和超过 32 KiB 的字符串。独立的四字节与八字节 BigInt 用例验证指针保持完整，并释放原始地址。测试持有的缓冲区在同步读取期间保持存活；原生解引用之前会检查指针字节。此前的扫描决策保留在[归档记录](../../archived/bug-fix/2026-08-23-win32-utf16-nul-truncation.md)中。
