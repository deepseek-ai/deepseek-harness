---
description: "The POSIX SSH provider family: shared connection, remote filesystem, managed subprocesses and file-effect sandbox."
kind: "package-group"
---

# ssh/ — POSIX remote execution providers

English | [中文](README.zh.md)

## Summary

This family runs files, ordinary processes, terminals and sandbox enforcement on one POSIX SSH host while the Harness stays local. A shared OpenSSH connection and installed helper support the existing filesystem, subprocess and sandbox interfaces. Use it in headless or custom profiles whose consumers honor provider-owned paths.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Responsibility | Service |
|---|---|---|
| [`ssh`](ssh/README.md) | Connection, helper identity and transport lifecycle | `ctx.ssh` |
| [`fs-ssh`](fs-ssh/README.md) | Remote file identity, reads and guarded atomic mutations | `ctx.fs` |
| [`subprocess-ssh`](subprocess-ssh/README.md) | Executable lookup, processes, control streams and terminals | `ctx.subprocess` |
| [`sandbox-ssh`](sandbox-ssh/README.md) | Remote file-effect confinement and enforcement facts | `ctx.sandbox` |

<a id="related-documentation"></a>
## Related documentation

- [SSH subsystem](../../docs/subsystems/ssh.md) — shared execution coordinates and transport ownership.
- [POSIX SSH decision](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) — alternatives, consequences and verification requirements.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Remote capability implementations retain the shared asynchronous terminal and cancellation interfaces. Local path access must never be inferred from a remote path string.

</details>
