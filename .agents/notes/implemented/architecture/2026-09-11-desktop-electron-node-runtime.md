# Agent Note: Use Electron as the Desktop Node runtime

Status: implemented

English | [中文](2026-09-11-desktop-electron-node-runtime.zh.md)

## Problem

Shipping an upstream Node executable alongside Electron duplicates the JavaScript runtime. Desktop needs one runtime for its Host and package scripts without requiring users to install Node.

## Decision

Desktop runs the shared Web Host and bundled pnpm through its own Electron executable with `ELECTRON_RUN_AS_NODE=1`. It ships no separate upstream Node executable. The target Electron distribution supplies both the packaging input and the runtime used to prepare and verify production dependencies; release metadata records its actual Node version. Development uses the installed Electron distribution.

This supersedes the separate-Node choice in the [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) and [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md). Their independent plugin storage and ordinary resource-directory layout remain applicable. The [Web wrapper](2026-09-10-desktop-web-wrapper.md) retains the shared profile runner and HTTP transport.

## Consequences

Host and pnpm launches pass `--expose-internals`: the bundled Cordis loader uses Node's internal ESM loader, while its native builtin accessor cannot locate the required symbol in Electron 44. The explicit flag makes that loader available without modifying Cordis. The RunAsNode fuse remains enabled.

The Host inherits the caller PATH without Desktop’s private `bin` directory, so PTC and agent shells cannot resolve internal launchers through that directory. `DSH_DESKTOP_NODE_EXECUTABLE` is injected only for package installation. Package-script environments prepend a small `node` shell launcher that forwards arguments to the current Electron executable. This supports shell lifecycle scripts without a system Node installation. On Windows it is `node.cmd`, not a replacement `node.exe`; third-party code that directly spawns the literal `node` executable without a shell must use `process.execPath` or provide its own runtime. Child processes inherit RunAsNode; worker threads inherit the Host's arguments. Desktop does not emulate upstream OpenSSL behavior or rebuild arbitrary third-party native addons automatically.

Electron's Node patches and native ABI are release compatibility obligations. The packaged native smoke exercises pnpm shell scripts without system Node on PATH, terminal output through the Windows shell, Koffi, Sharp, and HTML conversion. The Host smoke loads an external plugin sharing Cordis and serves its route through the real Web application. Platform signing and installed-application qualification remain required; Windows results do not establish macOS compatibility. Windows token signing runs serially and retains the first failure, preventing queued tasks from repeating a rejected PIN.

## Alternatives considered

A separate Node executable decouples the Host from Electron's runtime but adds another binary, download, signature, and version selection. Electron RunAsNode removes that duplication. Moving production packages into ASAR is a separate change involving native modules, package resolution, and subprocess paths; the Host continues to load ordinary resource files.
