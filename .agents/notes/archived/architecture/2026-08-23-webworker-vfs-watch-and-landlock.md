# Agent Note: Web Worker VFS watching and CLI-compatible confinement

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-23-webworker-vfs-watch-and-landlock.zh.md)

## Problem

The Web Worker preview boots the same Web profile and Agent presets as the Node host. Without a VFS change source, refusing `node:fs.watchFile` makes `skill-filesystem` return an incomplete observation and re-scan on every lookup, while an inert success leaves an existing root waiting forever for Chokidar's `ready`. Settings and credentials likewise need real external-edit events rather than a package-specific fake.

The same composition mounts `sandbox-local`, whose Linux chain probes bwrap and then `@deepseek-ai/node-addon-landlock-run`. A Worker cannot execute either binary. Ending the selection there makes `workspace-write` and `read-only` unusable even though every shell filesystem operation already crosses a Host-side VFS call point.

The filesystem compatibility boundary follows the [Worker Node face decision](2026-08-20-webworker-node-face.md): pure JavaScript watcher packages run unchanged over Node-compatible modules. Native or binary packages may keep their public JavaScript API and executable protocol while replacing the backend. An API that cannot preserve its caller-visible Node behavior remains explicitly unavailable; `node:vm` is outside this decision.

## Decision

### VFS mutation source and filesystem watchers

`MemoryVfs` publishes committed `write`, `mkdir`, `remove`, and `chmod` mutations to any number of subscribers. Publication happens after state changes, failed operations publish nothing, image seeding stays silent, and one throwing subscriber cannot fail the filesystem operation or starve another subscriber. Rename is a source removal plus complete destination mkdir/write records; destination writes mark the directory entry as changed, so watchers report `rename` while a future durable sink receives the bytes needed to materialize the destination. Directory mtimes advance when their immediate entry set changes, so polling detects child creation and removal as Node does.

The mutation record is shared with WebFS persistence rather than defining a second notification path. Writes carry their complete post-commit bytes and virtual permission bits, plus an append offset when only a tail changed. `MemoryVfs` accepts an optional asynchronous `VfsMutationSink`, sends the same records to that sink and live watcher subscribers, and exposes `flush()` through file-handle `sync()` and `datasync()`. Hydration supplies `{ mode, mtimeMs }` explicitly, so image permissions and durable timestamps cannot occupy the same positional argument. This change mounts no durable sink; it keeps the synchronous in-memory tree authoritative so an OPFS or user-directory mirror can hydrate before publication and write behind without changing `node:fs`.

The `node:fs` implementation provides callback `stat` and `lstat`, `watch`, `watchFile`, `unwatchFile`, `FSWatcher`, and `StatWatcher`; `node:fs/promises.watch` provides the abortable async iterator. One path shares one `StatWatcher` across listeners, listener-specific unwatching leaves peers active, and missing paths report zero-valued Stats before later creation, deletion, and recreation transitions. Callback dispatch captures the registration-time async context and checks closure before every queued delivery. A pre-aborted callback watch returns its watcher before asynchronously closing it, while a pre-aborted promise watch rejects its first iterator read with `AbortError`.

`fs.watch` maps entry creation, removal, and rename destinations to `rename`, and maps content or mode changes to `change`. Non-recursive directory watches report immediate child names; recursive watches report paths relative to the watched directory. The VFS has no symlinks, so this implementation does not invent symlink events.

### Streams and unchanged npm packages

`node:stream` uses the maintained `readable-stream` browser implementation for `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, pipeline helpers, async iteration, backpressure, aborts, and teardown ordering. The compatibility module sets the byte high-water default to the 64 KiB value used by the repository's Node 22+ engines. VFS-backed `ReadStream` and `WriteStream` supply file descriptors, inclusive ranges, encoding, append or replace behavior, byte accounting, AbortSignal handling, and `open`/`ready`/`finish`/`end`/`close` ordering. Descriptors retain their opened file identity and access mode across rename, replacement, and unlink; hard links share that identity and subsequent content or mode changes, while truncation zero-fills growth.

Chokidar and readdirp are ordinary image dependencies, not module replacements. Their package code runs unchanged and imports the Worker implementations of `node:fs`, `node:fs/promises`, `node:stream`, `node:events`, `node:path`, and `node:os`. Chokidar therefore retains its own initial scan, `ready`, polling, atomic-write normalization, write-settle delay, shared watcher, and close behavior.

### Landlock CLI over per-process VFS grants

`@deepseek-ai/node-addon-landlock-run` is an ordinary image dependency, not a module replacement. Its unchanged JavaScript entry runs through the Worker implementations of `node:child_process`, `node:module`, `node:path`, and `node:url`, so the package remains the sole owner of `LAUNCHER_BIN`, `LAUNCHER_FAILURE_EXIT`, `launcherPath()`, `grantArgs()`, and `probe()`. The image may include the matching Linux optional package, but package resolution does not decide whether the Worker platform supplies Landlock: the entry package's deterministic fallback path reaches the same platform executable implementation when that optional package is absent.

The process layer has a table of Worker platform executables identified by logical executable name rather than one package-manager path. Its `landlock-run` provider accepts a bare command or an absolute launcher path, parses the native package's unchanged CLI, validates every grant root, and delegates the inner argv to the existing shell process runner. `node:child_process` performs only generic executable lookup, output delivery, and settlement. The unchanged package's synchronous `probe()` therefore observes the provider through `spawnSync` and reports `full`. A usage error, missing grant root, or unknown inner executable prints one `landlock-run: ...` line, exits `125`, and never runs the inner command. The bwrap probe remains unavailable, so the unmodified `sandbox-local` Linux chain selects this Landlock backend.

Each launched process receives its own `ShellFileSystem` guard. `stat`, `list`, and `readText` require a read-only or read-write grant; `writeText`, `mkdir`, and `remove` require a read-write grant; `rename` requires both source and destination to be writable. Grant roots normalize trailing separators before containment checks. Denials carry `EACCES` and `permission denied`, preserving `bash-sandbox` denial classification. `/tmp` maps to the VFS `/dsh/tmp`, while `/dev/null` is a virtual empty-read and discarded-write file that stores no bytes.

The Worker's `full` verdict covers every file operation expressible through its shell command table and Host-served VFS protocol. It does not claim Linux kernel Landlock, arbitrary native executable support, or protection against a future shell program that bypasses `ShellFileSystem`.

### Explicitly deferred behavior

`node:vm`, `node:worker_threads`, `node:net`, `node:sqlite`, native PTY, Sharp, and ripgrep remain outside this change. The VFS remains POSIX-only, in-memory, and symlink-free. Browser Workers have no libuv-style ref-counted event loop, so watcher `persistent`, `ref()`, and `unref()` preserve the API and observable state but cannot decide Worker lifetime.

## Alternatives considered

**Disable watcher and sandbox rows in the Worker profile.** A smaller composition would stop testing the same Host tree and would hide package integration failures specific to preview deployment.

**Make `watchFile` an inert success.** Missing roots would never advance, and an existing root would wait forever for Chokidar `ready`.

**Notify watchers only from `node:fs`.** Shell process requests and any direct VFS writer would bypass the notification point. The commit owner, `MemoryVfs`, is the only complete source.

**Keep a VFS-specific Chokidar replacement.** This duplicates directory scans, ready accounting, write settling, atomic replacement, shared watcher ownership, and teardown already maintained upstream.

**Replace the Landlock entry package with a Worker module.** Reimplementing its exported constants, grant builder, launcher resolution, and probe would create a second copy of a package contract that already runs over the Worker Node compatibility layer. Only the platform executable implementation differs.

**Recognize one exact launcher path.** Optional-dependency installation and the entry package's documented fallback produce different absolute paths for the same executable. Package-manager layout is not the identity of a platform capability, so executable dispatch uses the logical `landlock-run` name.

**Add a Worker branch to `sandbox-local`.** This would copy policy-to-grant mapping into a business package. Interpreting the existing launcher protocol preserves the provider, consumer, configuration, diagnostics, and native package API.

**Store one active policy on the global VFS.** Concurrent foreground, background, and escalated commands would overwrite one another's authority. Grants belong to one process handle and its filesystem adapter.

## Verification

- `fs-watch-stream.spec.ts` compares missing/create/change/remove `watchFile` transitions and file-stream lifecycle, chunking, range, backpressure, byte count, defaults, and abort identity with the running Node version.
- `chokidar.spec.ts` loads both lockfile-selected Chokidar and readdirp dependency pairs through the Worker transformer and module loader, then proves `ready`, callback watching, polling, missing-file creation, removal, and quiescent close over `MemoryVfs`.
- `image-loadable.spec.ts` packs and loads the real `@deepseek-ai/node-addon-landlock-run` JavaScript, proves it is absent from the replacement table, and runs its fallback `launcherPath()` and `probe()` through the Worker platform executable. `child-process.spec.ts` and `sandbox-stack.spec.ts` then prove the launcher failure code, malformed argv and grant failures, `/tmp` and `/dev/null`, rename denial, all three permission modes, and concurrent process-local grants through the production sandbox and subprocess packages.
- `preview-boot.e2e.ts` builds and boots the packed browser deployment, creates a Workspace and Session, advances missing skill roots into a live Chokidar watch, lists the catalog, and completes settings and credential writes without watcher warnings.

## Consequences

The preview now runs npm watcher consumers without source forks, and filesystem mutations observed from Host code or shell process Workers share one ordered commit source. A WebFS/OPFS integration remains an asynchronous mirror around this synchronous authority and consumes that same source; it does not add another Chokidar implementation or a competing mutation protocol.

Worker `read-only` and `workspace-write` preserve the product's permission vocabulary and denial reporting without forking the Landlock npm package. Their security claim is narrower than native Landlock but complete inside the Worker execution world; any new filesystem message or shell program must continue through the guarded `ShellFileSystem`. Native-backed packages follow the same ownership rule: their JavaScript remains upstream, while the Worker platform replaces only the native artifact behind it.

The worker bundle gains `readable-stream` and its small browser dependency closure. In return, stream state and backpressure remain maintained upstream instead of becoming local compatibility code.

Watcher event timing is deterministic from VFS commits rather than inherited from an operating-system backend. This stays within Node's watcher contract, which does not guarantee native event coalescing, while tests pin every event distinction the current consumers require.
