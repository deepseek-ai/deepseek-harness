---
description: "Build and verify SSH helper executables with an embedded Node runtime for Linux and macOS."
kind: "package-library"
---

# @deepseek-ai/dsh-ssh-helper-runtime

English | [中文](README.zh.md)

## Summary

Run the SSH helper on a remote machine without installing Node or npm packages. Each archive includes the executable, its native resources and integrity metadata. The private carrier supports managed processes, terminals, sandboxing and an embedded PTC worker through the existing SSH providers. Project commands still use the remote machine’s own development tools.

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

### Build and installation

This private workspace produces release archives; it is not a profile plugin or an npm CLI. From a checkout with dependencies installed, build the current native platform:

```sh
pnpm exec tsx scripts/build-exe-for-ssh-helper.ts
```

The builder requires Node 24, a C/C++ compiler and the development headers from that Node installation. Linux additionally needs `musl-gcc`; its node-pty addon must meet the glibc baseline. The [native workflow](../../../.github/workflows/build-exe-for-ssh-helper.yml) prepares the compatible addon before packaging. `--target` selects one native target, `--skip-build` reuses prepared JS/native outputs, and `--dry-run` validates the target and dependency declarations without building.

| Target | Native archive | Checked deployment baseline |
|---|---|---|
| `node24-linux-x64` | `linux-x64` | glibc 2.28 |
| `node24-linux-arm64` | `linux-arm64` | glibc 2.28 |
| `node24-macos-x64` | `macos-x64` | macOS 14 deployment target |
| `node24-macos-arm64` | `macos-arm64` | macOS 14 deployment target |

Outputs live under `dist-exe/ssh-helper/`. Each `dsh-ssh-helper-<version>-<platform>-<arch>.tar.gz` has a companion `.sha256` file. The archive contains `dsh-ssh-helper`, `native/system/`, licenses and `manifest.json`; macOS also includes `dsh-ssh-helper-spawn-helper`. The manifest records the source commit, whether the source tree was dirty, embedded Node version, protocol and every payload file’s digest and permissions.

Verify the archive checksum, then extract the whole directory into a versioned runtime location outside the project and replaced temporary mounts. Keep the native resources beside the executable. The installation can be read-only; the helper user needs a writable temporary/cache location. Configure [`dsh-ssh`](../ssh/README.md) with `launch: { kind: "executable" }`, the absolute `helper` path and the executable’s SHA-256 from the manifest. The client obtains the embedded PTC invocation through `ctx.ssh.ptcLaunch`.

### Verification and publication

The [artifact verifier](../../../scripts/verify-ssh-helper-artifact.ts) accepts `--archive` and an optional `--report` path. It validates and relocates the archive, makes installation files read-only, and runs two concurrent Loader compositions sharing a fresh native cache. Those compositions exercise files, processes, PTY, native flock and PTC through the SSH providers. macOS also runs a worker under a policy denying the checkout and host Node. `--sandbox=required` requires real confinement; Linux’s additional `--backend=landlock-run` check makes the bwrap probe unavailable and requires the packaged Landlock runner.

The [OpenSSH verifier](../../../scripts/verify-ssh-helper-ssh.ts) accepts a Linux `--archive`. It creates a temporary glibc 2.28 SSH server with no Node installation, mounts only the release and a disposable public key, and exercises the production connection. Its portability lane makes no kernel-confinement claim; the native host lane owns that check. Test identities, host keys, ports and workspaces are private to the run.

Ordinary PR and master CI run source and build-script checks without building SSH executables. For changes to helper startup, native dependencies or packaging, manually run the [native workflow](../../../.github/workflows/build-exe-for-ssh-helper.yml) before merging; it accepts selected targets and defaults to all four. `CI master` also exposes the manual `ssh-helper` suite. [Release (SSH helper)](../../../.github/workflows/publish-ssh-helper.yml) defaults to `publish=false`: it builds all four targets from the selected ref and validates complete same-commit evidence from clean builds. With `publish=true`, it requires the matching `dsh-v<version>` tag and attaches the tested archives and `SHA256SUMS` to that GitHub release; a missing release is created as a draft. Native validation remains mandatory before publication. Deployment-target inspection alone does not establish execution on the oldest macOS version.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The carrier embeds its closed dependency set with the repository’s patched `pkg --sea` pipeline. Its entry dispatches the SSH helper, managed subprocess runner or PTC worker. Shared [deployment helpers](../../../scripts/executable-packaging.ts) also serve the Python SDK builder. Production deploy restores development installation state before invoking build tools, so pnpm’s automatic dependency check cannot prune them.

The operating system must execute the Landlock and PTY launchers from real files. A process-local resolution hook points the system package at its co-shipped native directory; node-pty uses its existing executable-relative spawn-helper convention. Binary inspection covers the embedded native modules before packaging and the external resources before publication.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH connection](../ssh/README.md) — authentication, invocation and lifecycle.
- [PTC Node runtime](../../ptc-runtime/ptc-runtime-node/README.md) — explicit worker launch and execution limits.
- [SSH subsystem](../../../docs/subsystems/ssh.md) — remote execution coordinates.

-----

<a id="model-experience"></a>
## Model Experience

None, as this private process carrier registers no model-facing tools or prompt content; its consumers own operation results.

#### KV Cache effect

The carrier adds no request-prefix content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Windows and musl-based Linux are not build targets. Sandbox availability still depends on the target kernel and system tools.
- Automatic download, deployment, updates and connection UI are separate from archive production.
- The executable accepts private worker invocations, not arbitrary Node CLI arguments. Project `node` commands and nested JavaScript subprocesses need their own Node installation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
