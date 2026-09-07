# Agent Note: Win32 folder-picker paths stop truncating at U+XX00 code units

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-23-win32-utf16-nul-truncation.zh.md)

## Problem

`readUtf16` in `packages/host/directory-picker-native/src/win32-dialog-bindings.ts` translated the `IFileOpenDialog` result buffer by scanning for a zero byte with `bytes[end] !== 0`. UTF-16LE encodes NUL as two zero bytes, so any BMP code unit whose low byte is zero — U+XX00, such as 开 (U+5F00) — ended the scan early. Selecting a folder like `C:\Users\XIAOPAN\Desktop\安卓开发` returned `C:\Users\XIAOPAN\Desktop\安卓`, and the workspace-creation call failed with `workspace-invalid-path ... ENOENT`.

## Decision

The scan ends only when both bytes of a code unit are zero, still advancing two bytes at a time over the same 32KiB `koffi.view` buffer. A regression test drives `readUtf16` through the existing fake koffi COM world with a path containing 安卓开发 (U+5F00), so the termination rule is proven without a real Windows host.

The fix is adopted verbatim from the community patch series on the `fix/win32-utf16-nul-truncation` branch of the ericcaiwx-star fork — [c8aac14703](https://github.com/ericcaiwx-star/deepseek-harness/commit/c8aac14703a517b8db1573f9ca4ed94dc58e276b) for the scan fix and [e1d6265cb9](https://github.com/ericcaiwx-star/deepseek-harness/commit/e1d6265cb930a0a74cba03c40e73ed872a83575f) for the fixture cleanup — reported in [discussion #580](https://github.com/deepseek-ai/deepseek-harness/discussions/580) (earlier reported in [discussion #563](https://github.com/deepseek-ai/deepseek-harness/discussions/563)). Both cherry-picks retain the original author, ericcaiwx-star; the upstream fork is the source of record for the patch.

## Alternatives considered

**Reject the community patch and rewrite the scan locally.** Rejected: the patch is minimal, fits the dialog's existing test approach, and a byte-identical cherry-pick preserves provenance and credit.

**Decode the whole buffer with `toString('utf16le')` and split at `\0`.** Rejected: it copies the entire buffer instead of scanning, and the split would still depend on the same two-zero-byte rule.

**Ask COM or koffi for a string length.** Rejected: the binding surface provides no length; the double-zero scan is the standard UTF-16LE NUL test.

## Consequences

- Any path containing a U+XX00 code unit survives the picker translation; paths with such characters (for example Chinese folder names) can be selected and used to create workspaces.
- The fix changes no ABI usage, buffer size, or dialog flow; the COM child-process architecture in the [Win32 folder dialog note](../feature/2026-08-02-win32-in-process-folder-dialog.md) is untouched.
- Real-dialog rendering and selection remain a manual Windows check; this change's regression test exercises only the byte-to-string translation against the fake COM world. The fixture path is synthetic (`C:\fixture\安卓开发`) so no real user path appears in the repository.
