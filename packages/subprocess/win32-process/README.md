---
description: "Low-level Win32 process primitives for maintainers implementing or debugging the Windows ACL sandbox and ordinary subprocess Job runner."
kind: "package-library"
---

# @deepseek-ai/dsh-win32-process

English | [中文](README.zh.md)

## Summary

This low-level Win32 process library is consumed by the Windows ACL sandbox and the ordinary subprocess Job runner. It owns the repository's one Koffi binding table for reusable process, stdio, and Job Object operations; it is not a Cordis service and does not choose sandbox policy or public child behavior. Read this page when maintaining either native process path or checking its handle-lifetime limits.

## Table of Contents

- [Behavior](#behavior)
- [Header verification](#header-verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="behavior"></a>
## Behavior

- **One reusable ABI owner** — `abi.ts` owns the Win32 constants and x64 layout values consumed by both process paths. `ffi.ts` lazily loads `kernel32.dll` and `advapi32.dll`, verifies `STARTUPINFOW` and `PROCESS_INFORMATION`, exposes typed operations and error formatting, and lets sandbox policy bind its remaining APIs through the same loaded libraries.
- **Restricted-token creation** — `RestrictedProcessSpawnOptions` requires the sandbox's primary token and uses `CreateProcessAsUserW`. Piped and inherited-stdio paths share command-line quoting, cwd, the restricted-token null-environment policy, checked return values, and handle cleanup.
- **Piped process primitive** — `spawnPipedProcess()` creates anonymous stdin/stdout/stderr pipes, closes stdin immediately, returns the two read ends, and leaves process waiting and pipe draining to the caller. Every partial failure closes the handles already owned by the operation, and every Koffi out-parameter or struct allocation is freed after its Win32 lifetime.
- **Inherited-stdio Job primitive** — `spawnInheritedJobProcess()` creates one kill-on-close Job, temporarily marks the current stdio handles inheritable, creates the restricted child suspended, assigns it to the Job, and then resumes its initial thread. Target code cannot run before Job assignment; controlled assignment or resume failures terminate the suspended child or close the assigned Job before releasing every owned handle.
- **Ordinary Job runner primitive** — `CurrentTokenProcessSpawnOptions` requires a resolved `applicationName`, the complete target environment, and three runner CRT descriptors dedicated to target stdin, stdout, and stderr. `spawnCurrentTokenJobProcess()` maps those descriptors to OS handles through Node's exported `uv_get_osfhandle()`, rejects invalid results, temporarily marks the handles inheritable, and passes them through `STARTF_USESTDHANDLES`. It sends a sorted UTF-16LE environment block with `CREATE_UNICODE_ENVIRONMENT`, creates the target suspended through `CreateProcessW`, assigns it to an unnamed kill-on-close Job, and resumes it only after assignment. The original command-line argv entry remains unchanged, and the runner can close its carrier descriptors without touching Node's own standard streams.
- **Ordinary settlement operations** — `pollProcessExit()` publishes direct exit separately, while `isJobEmpty()` reads `QueryInformationJobObject(JobObjectBasicAccountingInformation)` until `ActiveProcesses` reaches zero. Checked Job termination and handle closure keep the runner as the only native owner.
- **Explicit settlement ownership** — `waitForProcessExit()` waits and closes a sandbox process handle; ordinary runner process polling, Job accounting, and checked Job termination/closure remain separate operations. `drainPipe()` reuses one native count slot while draining, frees it, and closes the pipe read handle. Each caller owns its result composition and returned handles.

The Windows ACL sandbox adds SID, DACL, grant, workspace, and public child policy above these primitives.

<a id="header-verification"></a>
## Header verification

The process, stdio, and Job constants plus selected structure sizes and offsets are checked against the MinGW Windows headers by [`verify/abi-probe.cpp`](verify/abi-probe.cpp):

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp && ./abi-probe.exe
```

The Koffi `STARTUPINFOW` and `PROCESS_INFORMATION` definitions also assert their 64-bit sizes at module load. The probe additionally fixes pointer and handle widths, the Unicode-environment flag, and the basic Job accounting record size and `ActiveProcesses` offset used to determine quiescence; it remains the evidence for the other recorded offsets and constants.

<a id="model-experience"></a>
## Model Experience

### Process primitives

#### What the model sees

Nothing directly. The package exposes `Win32ProcessBindings`, `CurrentTokenProcessBindings`, and process primitives to the sandbox and ordinary runner, which own all model-visible tools, output, and diagnostics; this package contributes no prompt text or tool schema.

#### Token effect

None directly. Consumers decide whether process output enters a tool result or later model request.

#### KV Cache effect

The package contributes no stable request prefix, so it does not invalidate model KV caches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Windows-only native loading** — importing the generic types is portable, but resolving the binding table loads Windows DLLs and fails on other hosts. Cross-platform tests inject a binding table instead of loading native APIs.
- **No public process service** — the package intentionally does not wrap its primitives in Cordis or Node streams. A consumer must own its policy, async scheduling, output limits, cancellation, and final handle closure.
- **Restricted-token null environment** — the `CreateProcessAsUserW` sandbox primitives pass a null environment block and establish changes through `SetEnvironmentVariableW` first because an explicit block through Koffi fails with `ERROR_INVALID_PARAMETER`. The ordinary `CreateProcessW` runner instead requires a complete target environment and passes a sorted, double-NUL-terminated UTF-16LE block, including `=X:` drive entries, without mutating its own environment.
- **No standalone process API** — the package exposes the operations current sandbox and ordinary-runner consumers need, but it does not own Node streams, public handles, output policy, cancellation, or durable state.
- **Create-to-assignment interruption** — the target starts suspended and cannot execute before Job assignment, but an external termination of the runner in the narrow interval between process creation and assignment can leave the suspended target behind. The package does not claim atomic Job attachment.
- **Header evidence is architecture-specific** — the committed ABI probe and layout constants cover the repository's current 64-bit Windows targets. A new pointer width or incompatible Windows ABI requires updating the probe before support is claimed.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Operations own only call-local native handles.
