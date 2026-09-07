# Agent Note: the worker's Node face — builtins, VFS, and the shell process layer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-webworker-node-face.zh.md)

## Problem

The worker runs the web profile's Cordis configuration byte for byte — no worker-specific rows — so a browser's missing platform must be replaced at the module layer, where a proxied module keeps its identity and changes its implementation. That covers three fronts: the Node builtins the tree imports, the filesystem those builtins answer from, and a process layer for the bash tool. A structural `node:child_process` stub would let that tool mount and advertise itself to the model while every call fails.

## Decision

**Builtins.** The proxy table replaces Node builtins and external npm packages, never workspace or vendored modules. `./implemented/<module>.ts` carries real semantics over a worker data source; `./mock/<module>.ts` mounts silently and reports the missing capability when a call reaches it. The loader's table holds one memoized thunk per specifier — evaluation happens at first `require`, not at assembly — and each shim's exported face typechecks against Node's own module type, with the narrow, documented exceptions where structural identity (a real class) cannot be satisfied. Its `createRequire` face supplies both `resolve()` and `resolve.paths()` against the image's package root, allowing unchanged packages to discover manifests without loading targets. The worker installs the `process` global itself and fills it into the table at assembly. The shim includes `process.title`: packages such as `@xterm/headless` use that property's presence to select their Node path, while omitting it makes a dedicated Worker look like a browser Window and reaches DOM-only globals.

**VFS.** Memory is the truth. `statSync(path, { bigint: true })` returns Node's BigInt shape, and two fields carry real information because `dsh-fs-local`'s stale-write guard depends on them: `ino` is per-path identity from a monotonic counter (a recreated path reports a new identity), and `mtimeMs` is strictly increasing per entry (`max(now, previous + 1)`), because in-memory writes routinely land in one millisecond and an equal timestamp would let a stale overwrite pass. Committed mutations also drive the [Node-compatible watcher and confinement implementation](2026-08-23-webworker-vfs-watch-and-landlock.md). Boot diagnostics remain visible because cordis logger verbosity counts UP: `startWorkerHost` installs a console exporter with `levels: { default: 2 }` before any entry mounts, while an exporter with no declared level drops every warning.

**Shell.** `node:child_process` is a real implementation over the VFS. The grammar is bought — `@yarnpkg/parsers`' `parseShell` — and the evaluator and command table are owned, because every candidate interpreter brings its own filesystem: pipelines are strings handed along, and each program is a function over the VFS. Ordinary commands resolve from that table; native-package protocols may contribute Worker-owned virtual executable wrappers through the [watcher and confinement decision](2026-08-23-webworker-vfs-watch-and-landlock.md). A name in neither set reports `ENOENT` at direct spawn or `command not found` (127) inside shell source. Each `spawn` starts a child Web Worker from this same bundle, its first frame declaring the shell-process role, so the termination ladder is real: `SIGTERM` asks at the next command boundary, `SIGKILL` terminates the worker mid-loop — the preemption an in-thread interpreter can never have. The filesystem face is asynchronous end to end (child frames to the host VFS); `execSync`, `execFileSync`, and `fork` refuse, and `node-pty` stays a stub.

## Alternatives considered

**Replacing `dsh-subprocess-local` or the bash executor.** The first would let the proxy table replace a workspace package against its own classification and invert the layering; the second trips `dsh-permission-presets`' boot-time `sandboxMode` validation and drops tested timeout/output behavior.

**`@yarnpkg/shell`, WASM shells, WebContainer.** The matching interpreter is built on real Node streams (~1.5 MB closure to own); this deployment excludes WASM and WASI has no `fork`; all of them arrive with their own filesystem, the one part that cannot be reused.

**`SharedArrayBuffer` + `Atomics.wait` for a synchronous child filesystem.** Measured on the deployment target: without COOP/COEP headers `SharedArrayBuffer` is not defined, and GitHub Pages cannot set response headers. The asynchronous face is a superset; a SAB backend can slot under it later without touching a program.

**Fabricating stats or widening error predicates instead of honoring `bigint`.** Constant `ino`/wall-clock `mtimeNs` silently disable the stale-write guard; swallowing `FS_IO_ERROR` in skill discovery would have made the same bug a permanently empty catalog with no failure anywhere.

## Consequences

- `read-only` and `workspace-write` interpret the native Landlock launcher protocol and enforce per-process grants at the VFS frame gate; `danger-full-access` keeps the direct process path. The [watcher and confinement decision](2026-08-23-webworker-vfs-watch-and-landlock.md) owns the narrower meaning of `full` in this execution world.
- The Node-host ladder test (`tests/node/child-process.spec.ts`) is registered windows-unsupported: the ladder's win32 kill rung is taskkill-by-real-pid, undeliverable to a process-table pid, while the worker itself always reports `linux`.
- Output is incremental but not streamed: programs write into sinks forwarded as `data` events, and a pipeline stage completes before the next starts.
- `tests/node/process-shim.spec.ts` pins the Node detection field independently from the test runner's ambient Node process.
- The runtime's tests mirror `src/` (`tests/node/`, `tests/shell/`, `tests/storage/`, …), so each shim family owns its behavior cases beside the oracle-diff suites.
