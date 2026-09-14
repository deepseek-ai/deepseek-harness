# Architecture

The system package family supplies native mechanisms to Node callers: a Linux confinement executable and a POSIX file-lock binding. Consumers own sandbox policy and Session lifecycle.

## Package family

The ESM package `@deepseek-ai/node-addon-system` and its optional platform packages share one version. Platform metadata chooses the operating system and CPU; each package's `prebuilds.json` declares the files it must contain.

The `./landlock-run` entry owns Landlock path resolution, grant argv, and the functional probe. It does not load native addons. The `./flock` entry lazily loads `system.node` only when `tryLockExclusive(fd)` is called. Importing either JavaScript entry therefore works without a matching native payload. The package exposes these capability subpaths and its manifest, without a root export.

## Separate mechanisms

`landlock-run` remains a static musl executable with the [existing CLI contract](cli-contract.md). It installs confinement on itself before exec, and refuses to exec if enforcement is unavailable. A missing launcher or unsupported kernel produces an unusable probe.

`system.node` uses stable Node-API v8. Its flock operation follows [fs-ext's asynchronous callback model](https://github.com/baudehlo/node-fs-ext/blob/v2.1.1/fs-ext.cc): it runs `flock(fd, LOCK_EX | LOCK_NB)` in asynchronous work and records errno on that worker. The native callback receives zero or positive errno; JavaScript owns the promise and syscall error construction. Setup errors throw into that promise. Callback exceptions are reported through Node's uncaught-exception handler; unexpected Node-API failures terminate the process. A terminating environment may suppress JavaScript completion, but its cleanup waits for queued or running native work before freeing storage.

The descriptor belongs to the caller and must stay open through completion. The binding neither opens nor closes it; closing the final descriptor for its open file description releases the lock.

The JSONL backend retains its inode check, materialization timing, and close lifecycle. Windows uses its existing koffi semaphore and never calls this POSIX binding. The browser worker supplies a single-process replacement for the flock entry, while running the Landlock JavaScript API unchanged.

## Builds and release

Repository builds and `build:bench` explicitly build the host addon before running consumers. Each platform builds natively on its CI runner. Landlock is static-musl; Linux addons are separately built for glibc and musl, and macOS uses a Mach-O bundle. Stable Node-API removes the Node-major build dimension, not OS, CPU, or libc differences. CI exercises identical addon bytes under Node 20, 22, 24, and 26; Linux also runs the musl addon in Alpine containers.

Platform prepack validates file formats, architecture, payload completeness, and Node-API exports. The packed-install rehearsal installs local tarballs, checks their bytes, and exercises the installed mechanisms. Missing capabilities fail explicitly; no consumer install runs a compiler. [Packaging](packaging.md) and [release](release.md) own the operational details.
