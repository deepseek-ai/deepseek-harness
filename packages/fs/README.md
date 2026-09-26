---
description: "The filesystem package group: the ctx.fs provider contract, local and sandbox-enforcing backends, the read-before-edit policy plugin, and the model-facing file and search tools."
kind: "package-group"
---

# packages/fs

English | [中文](README.zh.md)

## Summary

The `fs/` group gives agents durable, policy-governed access to files: the `ctx.fs` service contract in `fs/`, the host-filesystem and sandbox-enforcing backends in `fs-local/` and `fs-sandbox/`, the read-before-edit policy in `fs-observation-policy/`, and the model-facing tools in `tool-fs/` (`read`, `read_image`, `write`, `edit`) and `tool-fs-search/` (`glob`, `grep`). A deployment mounts one backend, loads the policy for freshness-guarded mutations, and registers the tool packages the model should see; backends swap without touching the tools or the policy. File I/O takes no timeout by design: a deadline would kill work the OS still finishes, so cancellation is a best-effort signal at syscall boundaries.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Seven packages play the filesystem roles; the subsystem reference owns the exhaustive contracts and the error taxonomy.

| Package | Role | ctx key |
|---|---|---|
| [`fs/`](fs/README.md) | `ctx.fs` service contract: execution-world paths, bounded text I/O, and atomic mutations with an optional version guard | `ctx.fs` |
| [`fs-local/`](fs-local/README.md) | Host-filesystem backend: reads, writes, and edits real files on the local machine | registers on `ctx.fs` |
| [`fs-sandbox/`](fs-sandbox/README.md) | Sandbox-enforcing backend: fences writes and edits by the per-call sandbox mode while reads pass through | registers on `ctx.fs` |
| [`fs-observation-policy/`](fs-observation-policy/README.md) | Read-before-edit policy: records observed presence or absence and guards write/edit through the `fs/*` events | `fs/*` listeners |
| [`tool-fs/`](tool-fs/README.md) | Model-facing `read`, `read_image`, `write`, and `edit` tools plus their executor | registers on `ctx.tools` |
| [`tool-fs-search/`](tool-fs-search/README.md) | Model-facing `glob` and `grep` discovery tools backed by the packaged ripgrep binary | registers on `ctx.tools` |
| [`tool-str-replace-editor/`](tool-str-replace-editor/README.md) | Standalone `str_replace_editor` tool: `view`, `create`, `str_replace`, and `insert` over `ctx.fs` | registers on `ctx.tools` |

The policy is a plugin, not a service the tools inject: removing it leaves the bare provider's unconditional mutation behavior instead of breaking the tools. The mode fence in `fs-sandbox` and the read-before-edit gate compose. `tool-fs-search` deliberately does not extend the provider contract — search is a process-backed ripgrep workflow, so filesystem backends stay free of a universal search API.

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary and error taxonomy, then the decisions that shaped the family.

- [Filesystem subsystem](../../docs/subsystems/filesystem.md) — targets, outcomes, guards, policy events, and the error taxonomy.
- [Cross-family fs sandbox decision](../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) — the shared sandbox mode fence over the filesystem seam.
- [Portable execution world consumers decision](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md) — why filesystem and subprocess providers share one execution world.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
