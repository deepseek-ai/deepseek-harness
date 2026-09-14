---
description: "The bash capability family for deployments and maintainers choosing and composing a shell executor, sandboxing, and the model-facing bash and pwsh tools."
kind: "package-group"
---

# shell/ — bash capability family

English | [中文](README.zh.md)

## Summary

The shell group provides command execution to agents: run a foreground command and read its bounded output, or start a background process and poll it, on POSIX with Bash and on Windows with PowerShell. Exactly one executor implementation is mounted per composition; the sandboxing executors confine every command through the sandbox capability, and the model-facing `bash` and `pwsh` tools sit on top of whichever executor is mounted. Choose a Bash executor for POSIX, a PowerShell executor for Windows, and pick the sandboxing variant when commands need file-level confinement.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`shell`](shell/README.md) | Defines the executor contract: foreground runs, background handles, and request resolution | `ctx.shell` |
| [`bash-local`](bash-local/README.md) | Runs Bash commands as fresh `bash -c` processes on POSIX | registers `ctx.shell` |
| [`bash-sandbox`](bash-sandbox/README.md) | Runs Bash commands confined through the sandbox capability, reporting denials as facts | registers `ctx.shell` |
| [`pwsh-local`](pwsh-local/README.md) | Runs PowerShell commands as fresh `pwsh -Command` processes on Windows | registers `ctx.shell` |
| [`pwsh-sandbox`](pwsh-sandbox/README.md) | Runs PowerShell commands confined through the sandbox capability | registers `ctx.shell` |
| [`shell-env`](shell-env/README.md) | Supplies the managed `DSH_*` environment every shell command receives | `ctx.shellEnv` |
| [`tool-bash`](tool-bash/README.md) | Exposes Bash execution and background jobs to the model as the `bash` tool | registers on `ctx.tools` |
| [`tool-bash-persistent`](tool-bash-persistent/README.md) | Runs model shell calls in one owner-isolated persistent Bash session | registers on `ctx.tools` |
| [`tool-pwsh`](tool-pwsh/README.md) | Exposes PowerShell execution to the model as the `pwsh` tool | registers on `ctx.tools` |
| [`tool-pwsh-persistent`](tool-pwsh-persistent/README.md) | Runs model shell calls in one owner-isolated persistent PowerShell session | registers on `ctx.tools` |

A profile layer selects exactly one executor implementation (the win32 layer swaps the POSIX rows for the pwsh ones; mounting two fails loudly at load time on the duplicate service registration) and the model-facing tools it needs. A sandboxed composition also selects a `ctx.sandbox` provider and `ctx.sandboxPolicy`; the [base bundle](../bundle/base/cordis.patch.yml) owns the shipped wiring.

-----

<a id="related-documentation"></a>
## Related documentation

- [Bash executor subsystem](../../docs/subsystems/shell.md) — the shared request/spec vocabulary, results, background processes, and the complete service contract.
- [Sandbox subsystem](../../docs/subsystems/sandbox.md) — the confinement capability the sandboxing executors consume.

<a id="dev-note"></a>
## Dev Note

None.
