---
description: "The subprocess group map: the shared child-process service and its local host provider, for users and maintainers navigating the group."
kind: "package-group"
---

# subprocess/ — subprocess capability family

English | [中文](README.zh.md)

## Summary

Every child process and terminal session the harness runs — bash commands, language servers, persistent shells, and out-of-process subagent backends — starts, observes, and terminates through one shared service (`ctx.subprocess`), with a local provider running them on the host machine. It is not a standalone product feature: the consuming capability seams decide what each process means, and command semantics, deadlines, and model-facing presentation stay with them. The group provides executable lookup, bounded output capture with spill recovery, provider-managed process ranges with disclosed weaker fallbacks, and a scrubbed starting environment for every child.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`subprocess`](subprocess/README.md) | Defines the child-process service: executable lookup, managed process spawns, and real terminal sessions | `ctx.subprocess` |
| [`subprocess-local`](subprocess-local/README.md) | Runs host processes and terminals with native managed ranges where supported and explicit weaker fallbacks elsewhere | registers on `ctx.subprocess` |
| [`win32-process`](win32-process/README.md) | Owns shared Win32 bindings for sandbox and ordinary process creation, stdio, Job assignment, polling, waits, and handle cleanup | library — no ctx key |

The service keeps process lifetime across consumer reloads; consumers own what a process means (a bash command, a language server) and every default that shapes one.

-----

<a id="related-documentation"></a>
## Related documentation

- [Subprocess subsystem](../../docs/subsystems/subprocess.md) — spawn specs, output readers, outcomes, and the managed `DSH_*` environment.
- [Subprocess seam Agent Note](../../.agents/notes/archived/architecture/2026-07-26-subprocess-seam.md) — why the process half of the bash executors became its own seam.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
