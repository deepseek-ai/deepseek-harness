# Agent Note: Prebuilt system primitives

Status: implemented

English | [中文](2026-09-07-prebuilt-system-primitives.zh.md)

## Problem

The JSONL writer's `fs-ext` dependency compiled a NAN addon during consumer installation. Native compiler availability and Node module ABI changes therefore affected ordinary installs, including Node 26. The repository already maintained the Landlock launcher and its per-platform publication workflow.

## Decision

The independently versioned `@deepseek-ai/node-addon-system` family in [native/system](../../../../native/system/README.md) distributes the existing `landlock-run` executable and a stable Node-API v8 `system.node` addon. Platform packages select OS and CPU; Linux carries distinct glibc and musl addon files. macOS carries the addon without a Landlock executable. Neither the entry nor platform packages compile during installation.

The package has no root export. The `./landlock-run` JavaScript entry retains Landlock's API and [CLI protocol](../../../../native/system/docs/cli-contract.md). The `./flock` entry loads its addon only when `tryLockExclusive(fd)` is called. It runs `flock(fd, LOCK_EX | LOCK_NB)` in asynchronous native work and captures errno on that worker. The caller owns the descriptor through completion and releases its lock by closing it. Missing bindings reject acquisition rather than granting an unprotected lock.

The [Session write-lease decision](../feature/2026-08-31-cross-process-session-write-lease.md) continues to own acquisition timing, inode checks, close ownership, and crash semantics. Windows retains its existing koffi semaphore. The browser worker substitutes only the flock subpath; it uses the unchanged `./landlock-run` JavaScript API.

Source builds explicitly compile the host addon before repository tests and builds that need it. Native CI builds the complete platform payload and tests the same addon bytes across Node releases; Linux also exercises the musl payload in Alpine. Platform prepack rejects malformed or incomplete binaries, and an offline npm install rehearsal checks installed bytes and real lock behavior. Native [tests](../../../../native/system/test/flock.test.js) cover descriptor/process contention, close and crash release, independent errno values, and worker teardown.

## Alternatives considered

**Keep NAN and publish one build per Node ABI.** This retains a Node-major build matrix for a binding that needs only stable Node-API operations. The evaluated `fs-ext-extra-prebuilt@2.2.14` selected a Node 25 ABI 141 binary under Node 26 ABI 147; its default-install fallback also exited without building when NAN was hoisted.

**Bundle fs-ext into the parent tarball.** npm normally still runs bundled dependency installation hooks. Bundling alone neither suppresses compilation nor makes one binary portable across operating systems, CPUs, libc implementations, or Node ABIs.

**Replace flock with OFD/fcntl locks.** On ordinary Linux filesystems these locks do not necessarily exclude existing flock holders. A tmpfs probe admitted an OFD lock while fs-ext held flock, so this is not a behavior-preserving replacement.

**Use koffi for the POSIX call.** A synchronous call changes event-loop blocking behavior; reading errno after its asynchronous callback reads the wrong thread's value. A native async-work adapter keeps the syscall result and errno together without another FFI coordination layer.

## Consequences

The family owns a small C binding, platform builds, and installed-artifact verification rather than an entire filesystem-extension API. Node-API removes the per-Node-major binary requirement, not OS/CPU/libc requirements. The shared native release includes both capabilities, but importing or using one does not load the other. Landlock binary semantics, Windows locking, and released Session data formats remain unchanged.
