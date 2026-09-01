---
description: "File-reference discovery and @file mention grammar for host-backed UIs, for users and maintainers choosing the seam or pairing it with a provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-file-reference

English | [中文](README.zh.md)

## Summary

Host-backed user interfaces use `dsh-file-reference` to offer `@file` completion: a UI asks for path candidates for the addressed agent, the model types `@path` or `@"path with spaces"`, and picking a candidate inserts the matching mention as ordinary prompt text. The seam itself owns no filesystem access — a concrete provider such as `@deepseek-ai/dsh-file-reference-local` supplies candidates, ranking, caching, and invalidation. Selecting a candidate never reads or attaches file contents; the model must call a filesystem tool to inspect a file. Session Controller exposes the same discovery to browser consumers through the `fileReferences/list` Remote.

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

Choose this package when a host-backed UI (web or terminal) should offer `@file` completion, and pair it with a provider whose namespace matches the agent's effective `read` tool. Mounting the seam without a provider gives the UI an empty completion surface.

### Mention grammar

An `@path` token at the start of input or after whitespace triggers completion; an `@` inside another token, such as an email address, does not. `@"path with spaces"` opens a quoted mention, and a directory candidate keeps that quote open after its trailing slash so completion can descend another level. The formatter rejects paths with control characters or embedded quotes that the grammar cannot represent safely.

### Getting candidates

`ctx.fileReferences.list(agent, query, signal)` returns path-only file and directory candidates for one agent's working directory, deterministically ranked by the provider. Directory mentions render with a trailing `/` so completion can descend another level. Browser consumers call the Session Controller adapter as `ctx.remote.fileReferences.list`; the trailing signal cancels a slow autocomplete.

### Pairing with a provider

For a local filesystem, mount `@deepseek-ai/dsh-file-reference-local`; other namespaces (remote or virtual filesystems) need a provider whose discovery matches the effective tool. When the addressed agent can call `read`, a provider may install the stable `FILE_REFERENCE_PROMPT` guidance that tells the model to read a referenced file before claiming to have inspected it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the seam; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The package separates an abstract discovery service from a shared, browser-safe mention grammar, with providers owning namespace access, ranking, caching, and invalidation. The service remains wire-neutral; `dsh-api-session-controller` owns the `fileReferences/list` Remote adapter and delegates to the active provider after resolving its Agent.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Abstract `FileReferenceService` and `FILE_REFERENCE_PROMPT` |
| [`src/grammar.ts`](src/grammar.ts) | `activeAtToken` recognition and `formatFileMention` rendering |
| [`src/types.ts`](src/types.ts) | `FileReferenceCandidate` path-only result type |
| — | No runtime invariant companion is published; the interface retains no candidate or lifecycle state; concrete providers own their cache and invalidation relationships. |

### Main flow

The UI recognizes an active `@` token through `activeAtToken`, calls `list` with the query text, and renders the ranked candidates. On selection, `formatFileMention` emits the matching prompt spelling (`@path`, `@"path with spaces"`, or an open `@"dir/` for a quoted directory). No file content is read at any point; providers may additionally install the stable `FILE_REFERENCE_PROMPT` section when the addressed agent has a `read` tool.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shipped provider to the shared reference surface and the tools the candidates point at.

- [Local file-reference provider](../file-reference-local/README.md) — the shipped local-workspace implementation of this seam.
- [Session-reference subsystem](../../../docs/subsystems/session-reference.md) — the shared file-reference and session-reference contracts behind host UIs.
- [Context group map](../README.md) — sibling request-context packages.
- [Filesystem tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs) — the `read` tool that referenced paths are meant for.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the composed provider, which owns the file-reference guidance that this package's discovery seam and grammar delegate to it.

#### KV Cache effect

The interface and grammar add no request tokens; a provider-owned prompt section determines whether the reusable prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit. They are current package constraints.

- **Path candidates are advisory** — the seam does not prove that a later model-facing filesystem tool can access the same namespace; deployments must align the provider with the effective `read` implementation.
- **No file-content reference object** — selected files remain ordinary prompt text and require an explicit model tool call before their contents become model-visible.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
