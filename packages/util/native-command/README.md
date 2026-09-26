---
description: "Host-native command and path-opening utilities with shell-free execution, cancellation, desktop detection, and WSL path handoff."
kind: "package-library"
---

# @deepseek-ai/dsh-native-command

English | [中文](README.zh.md)

## Summary

`dsh-native-command` runs host executables without a shell and opens Host filesystem paths through the desktop. The command runner captures utf8 output, propagates cancellation, and hides transient Windows consoles. The path opener supports default-application and text-editor intents, browser-renderable documents, WSL translation, and desktop availability checks. It is a library, not a plugin: no `ctx`, no state, no events.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this runner when a host-side integration must execute one native command and needs its output, its failure, or both — and must never involve a shell.

### Running a command

```ts
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

declare const script: string
declare const signal: AbortSignal
const { stdout, stderr } = await runNativeCommand('osascript', ['-e', script], signal)
```

On exit 0 the call resolves with captured stdout and stderr. On any failure it rejects with the exit `code` and both captured streams attached, so a caller can tell a missing tool (`ENOENT`), a cancellation (`ABORT_ERR`), and a real command failure apart without re-running the command.

### Injecting the command boundary

The `NativeCommandRunner` type is the injectable command boundary for host integrations: pass the function (or a wrapper) where the integration needs a testable boundary, so tests can substitute a fake runner.

### Opening a Host path

`openNativePath(path, signal)` hands a path to the default application and prefers the named default browser for HTML and SVG where the platform can identify one. `openNativeAssociatedPath(path, signal)` always uses the file-type association, without a browser override. `openNativeTextFile(path, signal)` selects text-editor intent; on macOS it uses `open -t`. Windows hands every intent to Explorer, so the shell's own default-application resolution — the one a double-click uses — picks the application; Explorer receives the target as an encoded file URI and its exit code 1 counts as a delegated handoff, while cancellation, missing executables, and other exit codes still reject. This acknowledgement does not prove that an application opened the file. WSL paths are translated with `wslpath -w` before the Windows desktop receives them. `canOpenNativePath()` reports whether the current Host plausibly has a desktop target.

`revealNativePath(path, signal)` selects the file in Finder or Explorer, including WSL path translation, and opens its parent directory through `xdg-open` on desktop Linux. `nativeFileManager()` identifies that action for Host-derived UI labels; desktop availability remains a separate `canOpenNativePath()` check. Callers must authorize the absolute file path before invoking either operation. Platform dispatch is covered by injected-runner tests; native desktop verification belongs to the corresponding platform. Explorer receives an encoded file URI as a separate argument. Its exit code 1 is accepted as a delegated handoff; cancellation, missing executables, and other exit codes still reject. This acknowledgement does not prove that an application opened the file or that a window selected it.

`nativeFileApplications(path, signal)` returns registered applications, localized names, icons, and the current default. macOS 12 and later use LaunchServices; Windows uses Shell association handlers and resolves a packaged application’s indirect icon reference before extraction; Linux uses GIO with shared XDG desktop-entry and icon lookup. On macOS, copies sharing a bundle identifier and display name (staged self-updates, per-version installs) collapse to the system default, else the highest version; deliberate side-by-side installs keep distinct display names and both entries. `openNativeFileApplication(path, application, signal)` revalidates the handler against the complete registered list, so copies collapsed out of the display list stay openable, and never changes the system default. Windows delegates invocation to the Shell, and Linux delegates argument expansion to `gio launch`. WSL translates the path and uses the Windows adapter. Callers authorize the local file path. Native integration tests use private Windows file associations and Linux XDG roots on their respective platforms.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The command runner is a thin wrapper over Node's `execFile`. The path opener selects one shell-free command from platform and environment facts, while callers retain authority over which path may be opened.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public command-runner and path-opener exports |
| [`src/runner.ts`](src/runner.ts) | Shell-free `execFile` adapter |
| [`src/path-opener.ts`](src/path-opener.ts) | Desktop detection, open intents, browser preference, and WSL translation |
| — | No runtime invariant companion is published; each run is one stateless child-process round trip with no owned event stream or mutable runtime data; behavior is enforced by unit tests. |

### What execFile gives the runner

`execFile` spawns the executable directly with an argv array — no shell string, no shell interpretation of the arguments. The `signal` option terminates the child when the caller's abort fires; `windowsHide` suppresses the transient console window on Windows. On a non-zero exit or spawn error, the callback attaches `code`, `stdout`, and `stderr` to the rejected error and keeps the original error as `cause`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consumers or the general subprocess capability this utility deliberately is not.

- [Native directory picker](../../host/directory-picker-native/README.md) — the OS chooser commands this runner executes.
- [Session Controller](../../api/session-controller/README.md) — resolves Session-relative workspace paths before opening them.
- [Settings Controller](../../api/settings-controller/README.md) — selects settings documents.
- [Subprocess capability](../../subprocess/subprocess/README.md) — the general subprocess seam, of which this package is not a part.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side utilities register nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Linux association discovery and explicit launching require GIO. Missing native commands reject the query, and missing artwork returns null; callers can retain file-manager reveal as their fallback.


These limits define when this runner is not the right tool. They are current package constraints, not a task backlog.

- Command output uses Node’s `execFile` buffer limit; oversized replies reject. Use the subprocess capability for streaming output.
- A Windows handler icon appears only when the Shell resolves its indirect reference; an unresolved reference falls back to the handler executable, and a handler that names none — a packaged handler may report an AUMID or family name — yields no icon.
- A Windows host needs an interactive desktop session. In a non-interactive session — a service, or a scheduled task without an interactive logon — `explorer.exe` invokes no file association and still exits 1 after about a second (an SSH session 0 on Windows 11 ARM64 build 26200), so an open reports success having opened nothing; a caller's abort signal turns that wait into a timeout rather than a hang. An `Invoke-Item` command resolves the association in-process there, and its directory failure arrives as a non-zero exit code. No fallback for that session is implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
