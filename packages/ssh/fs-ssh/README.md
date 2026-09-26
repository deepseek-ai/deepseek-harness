---
description: "Remote filesystem semantics for consumers sharing files with SSH subprocesses."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-ssh

English | [中文](README.zh.md)

## Summary

`dsh-fs-ssh` provides `ctx.fs` in the SSH helper’s filesystem. File tools read and mutate the same files that remote Bash, terminals, language servers and Node programs see. Remote canonicalization, version guards and atomic mutations use the local filesystem implementations installed beside the helper.

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

Mount this provider with [`dsh-ssh`](../ssh/README.md) and `sandboxPolicy`; use its paired SSH subprocess and sandbox providers for execution. This provider has no configuration fields: connection identity and the default workspace belong to `dsh-ssh`, while file-effect mode belongs to `sandboxPolicy`.

`resolve()` canonicalizes paths on the remote host. `processPath()` and `fileUrl()` name files in that same remote namespace; they do not grant host-side access. File URLs encode literal percent signs, backslashes and newlines without changing the filename. `processPathFromHostPath()` returns `undefined`, so consumers requiring an installed executable or bootstrap must supply a remote artifact explicitly.

Reads preserve the shared filesystem error codes. Writes and edits send the resolved per-call policy to the helper, which canonicalizes the workspace and enforces it beside the atomic mutation. Lost transport reports an I/O failure; a mutation may already have committed and is not retried automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The helper reuses [`fs-local`](../../fs/fs-local/README.md) and [`fs-sandbox`](../../fs/fs-sandbox/README.md), preserving symlink identity, stale-version rejection, diff bases and publication semantics. UTF-8 streaming uses bounded pull requests and closes its remote iterator when the consumer stops early.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — shared operations and error meanings.
- [SSH connection](../ssh/README.md) — deployment and disconnection behavior.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through existing filesystem consumers, which present remote paths and file contents while owning every tool and prompt.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Whole-text reads and individual byte windows are limited to 8 MiB by the helper. Use text streaming or multiple byte windows for larger reads; other JSON transfers also obey the connection’s frame cap.
- Filesystem watching is unsupported: the provider keeps no `watch()` override, so the base `FS_IO_ERROR` rejection applies without polling or opening a local watcher for a remote path. Ordinary reads and consumer-owned manual refresh remain available.
- Remote file URLs are execution coordinates, not host filesystem handles or Web download links.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Wire validation and the owning filesystem, subprocess and sandbox providers enforce the observable obligations; this adapter adds no independently observed state relation.

</details>
