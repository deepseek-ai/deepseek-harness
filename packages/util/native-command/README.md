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

The `NativeCommandRunner` type is the injectable command boundary for host integrations: pass the function (or a wrapper) where the integration needs a testable seam, so tests can substitute a fake runner.

### Opening a Host path

`openNativePath(path, signal)` hands a path to the default application and prefers the named default browser for HTML and SVG where the platform can identify one. `openNativeTextFile(path, signal)` selects text-editor intent; on macOS it uses `open -t`. WSL paths are translated with `wslpath -w` before the Windows desktop receives them. `canOpenNativePath()` reports whether the current Host plausibly has a desktop target.

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
- [Settings Controller](../../api/settings-controller/README.md) — selects settings documents and agent-preset directories.
- [Subprocess capability](../../subprocess/subprocess/README.md) — the general subprocess seam, of which this package is not a part.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side utilities register nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this runner is not the right tool. They are current package constraints, not a task backlog.

- **No output bounding** — both streams buffer unbounded in memory; every current caller invokes small native tools whose output is a path or an error line. Adopt `dsh-output-retention` bounding before pointing this at commands with meaningful output volume.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
