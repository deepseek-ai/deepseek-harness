---
description: "The standalone str_replace_editor tool over ctx.fs for users and maintainers composing Claude-Code-style file editing for agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-str-replace-editor

English | [中文](README.zh.md)

## Summary

`dsh-tool-str-replace-editor` provides a standalone model-facing `str_replace_editor` tool over `ctx.fs`: `view` shows numbered file content or a shallow directory listing, `create` makes a new file, `str_replace` applies a unique literal replacement, and `insert` adds lines at a chosen boundary. It is composable with persistent Bash, one-shot Bash, sandboxed Bash, or another terminal surface. Mutations obey the same read-before-edit policy and sandbox fence as the rest of the fs family, enforced by whichever backend and policy plugins are mounted. Choose it when a deployment wants the Claude-Code-style single editor tool with absolute paths; the `dsh-tool-fs` package provides the alternative `read`/`write`/`edit` suite.

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

Mount the tool alongside a `ctx.fs` backend (and, for guarded mutations, the policy plugin) when the model should edit files through the familiar `view`/`create`/`str_replace`/`insert` command vocabulary on absolute paths.

### Minimal composition

A backend, optionally the policy plugin, then the tool; the editor composes with any terminal surface.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxOutputChars` | `16000` | Prefix characters retained for file and directory views |
| `description` | `Custom editing tool for viewing, creating and editing files` (multi-line) | Model-facing tool description |

### The commands

`view` returns one-based numbered file content (tabs preserved, so displayed text stays valid literal replacement input) or a two-level directory listing that omits hidden, dependency, and Python-cache entries. `create` makes a new file and refuses to overwrite an existing one. Command-specific fields may contain `null` placeholders when the selected command does not use them; required fields stay required, `view_range: null` selects the full view, and `str_replace.new_str: null` is rejected so deletion requires omission. `str_replace` requires one unique literal match, with errors reported in the public `old_str` vocabulary; `insert` follows the selected zero-based insertion boundary without adding an implicit trailing newline. Mutations preserve tabs outside the requested edit.

### Failures and recovery

A metadata miss from `view`, `str_replace`, or `insert` records confirmed absence before returning `FS_NOT_FOUND`, so a later `create` can recover an externally deleted path through the mounted policy's guarded-create flow; absence never authorizes `str_replace` or `insert`. Guarded mutations inherit the policy plugin's codes and remedies — `FS_NOT_OBSERVED` (read the file, then retry), `FS_STALE_VERSION` (re-read, then retry) — and sandbox denials surface as the `[sandbox: file access denied under <mode> mode]` marker. Paths must be absolute; a relative path is refused with a hint.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the editor tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The tool is one schema with four commands over `ctx.fs`. Mutations never touch the provider directly with their own assumptions: each one runs the `fs/write-intent` or `fs/edit-intent` waterfall to obtain the policy plugin's guard, resolves the per-call sandbox policy when the mounted `ctx.fs` confines, and delegates enforcement to the provider. `str_replace` and `insert` additionally re-read the file and use the observed version as the compare-and-swap basis when no policy plugin supplies a guard.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The whole tool: schema, command dispatch, view rendering, mutation policy |

### How each command runs

Every command resolves the absolute path first; mutations then follow one shared flow — policy guard, provider enforcement, then an `fs/observed` record on success — while `view` only stats and renders. The entire tool — schema, command dispatch, and view rendering — lives in `src/index.ts`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tool to the contract, policy, and backends it composes with.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract this tool consumes.
- [tool-fs](../tool-fs/README.md) — the alternative `read`/`write`/`edit` tool suite.
- [fs-observation-policy](../fs-observation-policy/README.md) — the policy plugin that guards mutations through the `fs/*` events.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend that fences mutations.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-str-replace-editor) — the exhaustive schema this package registers.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`str_replace_editor` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-str-replace-editor), including the configured `description`. The plugin contributes no standalone system-prompt section.

#### Token effect

Fixed schema cost while `str_replace_editor` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Views return numbered text or a shallow directory listing. Calls expose file locations, and create/replace calls expose diff cards to presentation surfaces. Mutations return concise confirmations. Long views keep their prefix and append a clipping notice.

#### Token effect

Data-dependent and bounded by `maxOutputChars` plus the fixed clipping notice.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the editor tool is a poor fit or needs special operational care. They are current package constraints, not a general editor comparison or a task backlog.

- **Operations target UTF-8 text** — binary files are unsupported.
- **`str_replace` intentionally rejects zero or multiple matches** — it has no `replace_all` argument.
- **Every mutation goes through the mounted policy and sandbox** — `fs/write-intent` or `fs/edit-intent` resolves the current session sandbox policy and delegates enforcement to the mounted filesystem and policy plugins, so a deployment without them gets unconditional mutations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The tool adapter owns no independent durable state; filesystem mutation relations stay with the provider and policy plugins.
