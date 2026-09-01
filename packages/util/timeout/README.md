---
description: "Shared timeout arithmetic, deadline fusion, and timeout-versus-cancel classification for capabilities that clamp a caller's hint, arm a deadline, and must tell the two apart later."
kind: "package-library"
---

# @deepseek-ai/dsh-timeout

English | [中文](README.zh.md)

## Summary

`dsh-timeout` lets a capability run one unit of work under a caller-visible timeout and later tell a timeout apart from a cancellation. A caller's optional hint is clamped against a backend default and cap, and upstream cancellation fuses with the deadline into one `AbortSignal`. The deadline signal only notifies — each capability owns the mechanism that stops its work, so no shared layer needs to know how to stop anything. For streamed transports an idle watchdog arms a timeout only while a provider read is outstanding, so consumer think time never counts as idle. A `timeoutMs` of zero is the internal no-timeout sentinel for backend-owned background work, never a public disable switch; the zero-dependency library is shared by the bash, web, subprocess, and tool-timeout-policy consumers.

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

Use `deadline` when a capability runs one unit of work under a caller-visible timeout, and `idleWatchdog` when it reads a streamed transport. Validate caller hints with `clampTimeout` first so the `timeoutMs` that reaches `deadline` is always positive and finite.

### Clamping a timeout hint

```ts
import { clampTimeout } from '@deepseek-ai/dsh-timeout'

declare const requested: number | undefined
declare const DEFAULT_TIMEOUT_MS: number
declare const MAX_TIMEOUT_MS: number

const timeoutMs = clampTimeout(requested, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'bash-local: request.timeoutMs')
```

`clampTimeout` fills the backend default when the hint is absent, caps the result at the backend maximum, and rejects a non-positive or non-finite hint with the caller-provided name. Zero is never accepted here: it is not a public disable-timeout value.

### Running work under a deadline

```text
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

using d = deadline(upstream, timeoutMs, 'BASH_TIMEOUT')
const outcome = await runWork({ signal: d.signal })   // work listens on d.signal and terminates itself
const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
const aborted = d.signal.aborted && !timedOut
```

The signal only notifies: the caller must attach its own termination — hand `d.signal` to `fetch`, or listen for `abort` and kill the child. Racing a promise against a timer would resolve the tool call while the child process or socket leaks on.

### Classifying the outcome

`timeoutOf(signal, code)` recovers the timeout reason only when this deadline's timer fired first. Pass your own `code` so classification composes under nesting: when `upstream` is itself a deadline signal, a foreign timeout reads as an ordinary upstream cancellation instead of claiming that the local timer expired.

### Streaming with an idle watchdog

```ts
import { idleWatchdog } from '@deepseek-ai/dsh-timeout'

declare const upstream: AbortSignal | undefined
declare const idleMs: number
declare const providerIterator: AsyncIterator<unknown>

using watchdog = idleWatchdog(upstream, idleMs, 'LLM_STREAM_IDLE_TIMEOUT')
const next = await watchdog.next(providerIterator)    // timer runs only while this read is outstanding
```

The timer is armed only while an iterator `next()` is outstanding and rearms on `pulse()` for transport activity that yields no value, so consumer think time between reads never counts as idle. The interval must be positive, finite, and no greater than `MAX_TIMER_DELAY_MS`.

### What does not get a timeout

Local file `read`/`write`/`edit` take no `timeoutMs`: file IO runs untimed because a deadline would kill work the OS will still finish.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The library is built on one boundary: share the timing and classification, keep the hard kill local.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `clampTimeout`, `deadline`, `idleWatchdog`, `timeoutOf`, `TimeoutReason`, `MAX_TIMER_DELAY_MS` |
| — | No runtime invariant companion is published; this pure utility owns no event stream or mutable runtime data; its value algebra is enforced by unit tests. |

### How a deadline fuses sources

`deadline` arms one timer and fuses its abort with the upstream signal via `AbortSignal.any`, which adopts the reason of whichever source aborts first — so a race resolves to a single cause. The `TimeoutReason` carries the capability-owned `code` and the elapsed `timeoutMs`; `timeoutOf` reads it only when the timeout won, and upstream-wins leaves an ordinary abort reason. `[Symbol.dispose]` clears the timer.

### The no-timeout sentinel

`timeoutMs <= 0` arms no timer and forwards only the upstream signal — or a never-aborting signal when there is none — so every caller keeps one call shape. The sentinel exists for backend-owned background work; external request hints are validated positive and finite before they reach `deadline`.

### Why an idle watchdog rearms

`idleWatchdog` keeps one stable fused signal and arms the timer only while `next()` is outstanding; resolution disarms, later demand or `pulse()` rearms, disposal clears, and concurrent demand rejects. Only the transport observes the signal, so the provider's real read must listen to it — the DeepSeek and pi-ai adapters close their response body or SDK request on abort.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consumers or the boundary decision behind the library.

- [Timeout-deadline library Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the shared-timing, local-kill boundary.
- [Tool-call timeout policy](../../guard/timeout-policy/README.md) — the consumer that enforces declared tool timeouts.
- [Bash provider](../../shell/bash-local/README.md) — a foreground deadline consumer that kills a process group.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — why local file IO runs untimed.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the timeout consumers that render timeout outcomes.

#### KV Cache effect

No direct invalidation; the timeout consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the library deliberately does not do. They are current package constraints, not a task backlog.

- **Notification only** — a deadline cannot stop work that ignores its signal; every capability still needs its own socket, process, or task termination path.
- **`timeoutMs <= 0` is internal vocabulary** — it disables the local timer only after an owning backend has resolved policy, never as a public model- or plugin-facing knob.
- **The first abort reason wins classification** — when an upstream cancellation beats the local timer, this layer cannot later report that its own timeout would also have elapsed.
- **An idle watchdog is not a total deadline** — it rearms per outstanding iterator demand and deliberately excludes consumer think time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
