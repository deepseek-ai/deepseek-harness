---
description: "The process-sandbox package group: the confinement seam, per-platform backends, the shared policy resolver, and the Windows write-restriction rung."
kind: "package-group"
---

# packages/sandbox

English | [中文](README.zh.md)

## Summary

The `sandbox/` group confines subprocess execution to a file-effect policy: commands run `read-only`, write only under the session workspace (`workspace-write`), or run unrestricted (`danger-full-access`). Four packages deliver it: the confinement service (`sandbox/`), the per-platform backends for Linux, macOS, and Windows (`sandbox-local/`), the shared policy resolver (`sandbox-policy/`), and the Windows write-restriction backend (`sandbox-windows-acl/`). A confined call that a policy denies can retry through a user-approved one-time escalation. Confinement is same-world only: it shares the host kernel and filesystem, while containers, microVMs, and remote executors replace whole capabilities instead of registering here.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Four packages play the confinement roles; the subsystem reference owns the exhaustive contracts and the per-call policy semantics.

| Package | Role | ctx key |
|---|---|---|
| [`sandbox/`](sandbox/README.md) | Confinement service contract: modes, enforcement, per-call policy, and the escalation vocabulary | `ctx.sandbox` |
| [`sandbox-local/`](sandbox-local/README.md) | Per-platform confinement backends: Linux bwrap then Landlock, macOS Seatbelt, Windows restricted token | registers on `ctx.sandbox` |
| [`sandbox-policy/`](sandbox-policy/README.md) | Shared policy home: deployment defaults and per-session mode overrides for every enforcing family | `ctx.sandboxPolicy` |
| [`sandbox-windows-acl/`](sandbox-windows-acl/README.md) | Windows write restriction: confined children may write only in the workspace and a private temp directory | — (mounted by `sandbox-local` as the win32 backend) |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then the confinement decision and its cross-family extension.

- [Process sandbox subsystem](../../docs/subsystems/sandbox.md) — modes, per-call policy, wrapped-argv dialects, and fail-closed errors.
- [The historical subprocess sandbox decision](../../.agents/notes/archived/feature/2026-07-06-sandbox.md) — the capability boundary, escalation choreography, and deferred phases.
- [Cross-family file sandbox reference](../fs/fs-sandbox/README.md) — the shared policy home and the sandboxed filesystem provider.
- [Windows ACL restricted-token sandbox decision](../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) — why raw ACL restricted tokens over mxc and AppContainer.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
