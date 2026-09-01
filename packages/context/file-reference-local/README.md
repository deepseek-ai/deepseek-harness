---
description: "Local-workspace @file completion provider for users and maintainers enabling, sizing, or debugging ctx.fileReferences discovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-file-reference-local

English | [中文](README.zh.md)

## Summary

Agents and their host UIs get ranked path candidates for `@file` mentions, scoped to each agent's workspace and bounded so even large repositories stay responsive. `dsh-file-reference-local` implements `ctx.fileReferences` for the local filesystem: it keeps one reusable search index per agent, rebuilds it in the background after tool results so completion reflects workspace changes without stalling, and never follows directory symlinks. When the addressed agent can call `read`, it also installs a stable one-sentence guidance into the system prompt. Choose it when the agent's `read` tool operates on the Harness host filesystem; remote or virtual namespaces need a provider whose discovery matches the tool.

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

Mount this provider when `@file` completion should discover the Harness host's own filesystem — the namespace the shipped `read` tool operates on. Each agent's workspace is indexed from its session working directory, falling back to the host process directory when the session has none.

### Enabling the provider

The defaults suit a typical workspace, so the minimal mount needs no configuration:

```yaml
- name: '@deepseek-ai/dsh-file-reference-local'
  config:
    maxResults: 20
```

### What you get

Typing `@` in a host UI returns up to `maxResults` ranked path candidates for the addressed agent. A query containing `/` lists the matching directory's entries directly; a bare query fuzzy-ranks the bounded recursive index. Directory candidates keep the mention open with a trailing slash. After any tool result the agent's index is marked stale: the next query still answers from it and its replacement builds in the background, so a rebuild never sits in front of the caret.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxResults` | `20` | Maximum ranked candidates returned for one query |
| `maxEntries` | `50000` | Maximum files and directories indexed per agent workspace |
| `excludedDirectories` | `['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle']` | Directory basenames omitted from traversal and candidates |

Every numeric value must be a positive safe integer, and every excluded name must be a non-empty basename without `/` or `\`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the provider; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The provider maintains one reusable `WorkspaceFileSearch` per agent, rooted at that session's `cwd`. Directory-scoped queries (`a/b/...`) list live directory state, while bare fuzzy queries share one bounded recursive traversal. Only a workspace's first bare query waits for that traversal; a `tool/result` event marks the settled entries stale, and the next bare query serves them while the replacement builds. The model guidance is a per-agent prompt section contributed only while the addressed agent has a `read` tool; agent disposal releases both the index and the prompt fiber.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `LocalFileReferenceService`: config validation, per-agent searches, prompt install |
| [`src/search.ts`](src/search.ts) | `WorkspaceFileSearch`: traversal, ranking, exclusion, staleness and background rebuild |
| — | No runtime invariant companion is published; per-agent indexes are private advisory caches whose invalidation and disposal are observed directly through service tests. |

### Main flow

A `list(agent, query, signal)` call either lists one directory's entries or reads the shared bounded index, ranks the candidates (exact, prefix, substring, then subsequence scores with directory bonuses), and returns at most `maxResults` in deterministic order. `tool/result` events mark the addressed agent's index stale so a later bare query observes a fresh tree. An unreadable or excluded subtree contributes no candidates, while an unreadable root fails its traversal instead: a transient failure must not replace still-good entries with an empty index.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the seam this provider implements to the tools its candidates point at.

- [File-reference seam](../file-reference/README.md) — the service contract and `@file` grammar this provider implements.
- [Session-reference subsystem](../../../docs/subsystems/session-reference.md) — the shared file-reference contract behind host UIs.
- [Filesystem tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs) — the `read` tool whose namespace discovery must match.
- [Context group map](../README.md) — sibling request-context packages.

-----

<a id="model-experience"></a>
## Model Experience

### File-reference guidance when read is available

#### What the model sees

When the addressed agent has an effective `read` tool, the provider contributes this stable system-prompt section:

##### File-reference instruction

```markdown
Tokens prefixed with @ are workspace paths the user explicitly referenced, relative to the workspace root. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.
```

#### Token effect

Conditional and fixed: the one sentence is present while `read` is visible to the addressed agent; candidate lookup itself adds no tokens, and a selected path contributes only its ordinary user-message characters.

#### KV Cache effect

The stable sentence joins the system-prompt prefix. Mounting or removing this provider, or changing whether `read` is visible, changes that prefix; queries, candidates, and index staleness do not.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Host-local namespace** — the provider scans the Harness host filesystem, so remote or virtual `read` implementations require a provider whose namespace matches the tool.
- **Bounded advisory index** — very large workspaces may omit paths after `maxEntries`, and excluded or unreadable directories do not appear. The default exclusions name only build outputs no ecosystem also uses for sources; `lib` is deliberately absent, so a workspace that builds into it adds that name through `excludedDirectories`.
- **One invalidation of staleness** — a bare query answered right after a tool result reflects the tree as of the previous traversal; the following query sees the rebuild.
- **No ignore-file semantics** — `.gitignore` and other project ignore files do not influence discovery; only configured directory basenames are excluded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
