# Agent Note: Wait for the Windows Python console runtime

Status: implemented

English | [中文](2026-09-06-windows-python-console-spawn-wait.zh.md)

## Problem

The installed Python `dsh.exe` console command intermittently exits with Windows access violation `0xc0000005` before initializing a profile. Its smoke assertion omitted the process status and reported only empty streams. A [native faulthandler probe](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34030851888) captures the fault in Python 3.10 `os._execvpe`, called by the runtime console entry, rather than in the bundled Node executable. Direct executable controls pass.

## Decision

The [Python console entry](../../../../python/sdk-runtime/src/deepseek_harness_runtime/__init__.py) uses `subprocess.run` on Windows, inherits standard streams and environment, waits for runtime completion, and exits with the runtime status. POSIX retains `os.execvpe` process replacement. Windows CRT exec is not POSIX process replacement; the explicit spawn-and-wait path avoids the observed native exec operation.

The [installed-wheel smoke](../../../../scripts/smoke-python-runtime.py) reports decimal and unsigned 32-bit hexadecimal status alongside captured streams when profile installation fails. This preserves the distinction between ordinary command failure and native process exceptions.

## Alternatives considered

**Disable Node compile caching.** Not selected: cache environment changes correlated with early probes, but cold-cache controls also passed and Python faulthandler locates the actual fault at the native exec call. Cache configuration remains unchanged.

**Retry or bypass the installed console command.** Rejected because either masks the shipped command failure instead of repairing its process launch. The keyless installed-wheel assertion remains required.

## Consequences

Windows keeps a Python parent until the runtime exits; it no longer depends on CRT overlay behavior. The standard synchronous subprocess implementation owns waiting and interruption cleanup. No custom process-tree manager or global host setting is added.

[Runtime-resolution tests](../../../../python/sdk/tests/test_runtime_resolution.py) retain POSIX forwarding and cover Windows argument/environment forwarding, statuses 0/37/513, real child completion, Unicode streams and arguments with spaces. Native Windows owns the wide exit-status case because POSIX truncates process statuses to eight bits. The [native fixed-count comparison](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34031142773) passes all four patched launches with compile caching enabled; all four unpatched controls also pass in that batch, so it is not a same-batch reproduction. Full installed-wheel CI must validate the final artifact separately from local branch-level tests.
