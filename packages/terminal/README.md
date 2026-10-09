---
description: "Package map for the persistent terminal service and the shell backend that starts interactive bash or pwsh."
kind: "package-group"
---

# terminal/ — persistent PTY capability family

English | [中文](README.zh.md)

## Summary

The `terminal/` family lets agents keep interactive shell and REPL sessions alive across tool calls, including the working directory, environment variables, and running child processes. Use `terminal/` for owner-isolated session management, `terminal-bash/` for sandboxed interactive bash or pwsh sessions. Choose this family when a task needs interactive input or state that a one-shot bash command cannot retain. Sessions remain local to one harness process and do not survive a restart.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

This group contains one session service and one shell backend. Each child README owns the full contract; the subsystem reference owns the shared vocabulary and the generated service surface.

| Package | Role | ctx key |
|---|---|---|
| [`terminal/`](terminal/README.md) | Session service: owner-scoped sessions with opaque ids, exact-owner fencing, and awaited cleanup | `ctx.terminals` |
| [`terminal-bash/`](terminal-bash/README.md) | Shell backend: interactive bash or pwsh under the shared sandbox policy, with readiness detection and bounded output | registers a backend on `ctx.terminals` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared types and the service surface, then the Agent Note for the design rationale and deferred boundaries.

- [Terminal subsystem reference](../../docs/subsystems/terminal.md) — ids, backend and session contracts, send readiness, bounded reads, and the generated `ctx.terminals` API.
- [Persistent PTY Agent Note](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — the design decision, alternatives, and deferred work.
- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.

See [`tool-terminal`](../experimental/tool-terminal/README.md) for the experimental optional capability.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
