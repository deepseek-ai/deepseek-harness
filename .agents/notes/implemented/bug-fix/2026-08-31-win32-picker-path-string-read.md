# Agent Note: Read the Win32 picker path without a fixed-size unmanaged view

Status: implemented

English | [中文](2026-08-31-win32-picker-path-string-read.zh.md)

## Problem

The Win32 picker needs to decode a NUL-terminated UTF-16 string allocated by `IShellItem::GetDisplayName` and release it through `CoTaskMemFree`. A fixed-length external ArrayBuffer adds a runtime requirement and manual terminator scanning without providing the allocation size.

## Decision

`readUtf16` stores the native address in a pointer-width buffer and passes it to generic `koffi.decode(buffer, 'str16')`. Generic decoding expects a pointer variable, not the string address directly. The slice follows `koffi.sizeof('void *')`; Koffi 3 represents native addresses as BigInt. The allocation must remain valid and NUL-terminated during decoding. Successful conversion leaves the original address available for `CoTaskMemFree`; if decoding throws, the string is not freed.

## Alternatives considered

**External view and manual scan.** This requires external-buffer support and duplicates Koffi's string conversion. Neither a fixed view nor growing chunks establish the native allocation size.

**String-typed out-param.** `_Out_ str16 *` returns text but discards the pointer needed for explicit COM release. Built-in `str16!` disposal uses the CRT allocator rather than the COM allocator.

**Custom disposable type.** A Koffi disposable can call `CoTaskMemFree`, but explicit conversion keeps the address and release at one call site without registering a native type.

## Consequences

Real-Koffi tests exercise the production result-path conversion over live UTF-16 buffers, including U+5F00, surrogate pairs, NUL termination and strings exceeding 32 KiB. Separate four- and eight-byte BigInt cases verify pointer preservation and release of the original address. Test-owned buffers stay live through the synchronous read; pointer bytes are checked before native dereferencing. The earlier scanning decision remains in the [archived note](../../archived/bug-fix/2026-08-23-win32-utf16-nul-truncation.md).
