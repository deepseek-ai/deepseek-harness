---
description: "Shared export filenames and native file drag requests for Web and Desktop."
kind: "package-library"
---

# @deepseek-ai/dsh-util-file-drag

English | [中文](README.zh.md)

## Summary

Callers can export files with the same safe filename in Web and Desktop. MIME data fills missing suffixes without limiting accepted file types. The library also declares native byte and authorized-resource requests; it holds no files or application state.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

`resolveDragFileName({ name, mediaType, outputExtension })` sanitizes path separators, reserved characters, and Windows device names. An explicit output suffix wins. Otherwise a compatible existing suffix is preserved, a known conflict is replaced using the declared MIME, and a missing suffix is completed from the maintained `mime` database. Unknown types retain a supplied name or suffix; unnamed content starts with `file`. Names fit 255 UTF-8 bytes, preserving the suffix and whole Unicode characters. Desktop validates wire input before using this typed resolver.

`FILE_DRAG_TOKEN_TYPE` names the browser transfer's `application/x-dsh-file` entry. Senders and drop targets import it directly from this package; the owning plugin retains the file bytes. The package root is safe to inline into client bundles because its exports share no runtime identity or application state.

`DesktopFileDrag.prepare(source, requestId)` accepts complete bytes or a Session resource reference, returning an opaque handle. `cancel(requestId)` stops unfinished preparation before a handle is available. Resource borrowing requires Host authorization and main-process content/name checks; callers fall back to byte preparation when borrowing is unavailable. [The plugin](../../client/ui-file-drag/README.md) owns browser preparation and [Desktop](../../../apps/desktop/README.md) owns native delivery.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Names describe the caller-declared MIME; this library does not inspect content or infer an unknown format. Explicit suffixes intentionally override MIME naming.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
