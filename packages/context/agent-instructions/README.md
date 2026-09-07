---
description: "Workspace-instruction context for users and maintainers enabling, sizing, or debugging AGENTS.md/CLAUDE.md loading and refresh."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-instructions

English | [中文](README.zh.md)

## Summary

`dsh-agent-instructions` loads `AGENTS.md`-compatible workspace instruction files into model context: the user-global file and the project chain reach the first request as one durable baseline, and successful `read`, `write`, or `edit` calls bring newly relevant nested files, changes, and removals into later requests. `dsh-base` includes it by default, and a profile patch can disable it. Everything is bounded by a byte budget: broader files are omitted before the most specific file is truncated, and an empty chain contributes nothing. There is no file watcher — external edits become visible on the next successful filesystem touch or when a resumed session reconciles its baseline.

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

Mount this plugin when agents should work from the workspace's own instruction files. `dsh-base` already includes it with a 65,536-byte budget, so base-backed profiles only need to replace the row when they want another `maxBytes`; providerless trees load nothing until a filesystem provider is present.

### What the agent gets

The first request includes one durable baseline message with the user-global `$DSH_HOME/AGENTS.md` followed by the project chain — every existing candidate file from the project root down to the session working directory, in broad-to-specific order. Sibling files whose content matches after trimming render once, so a `CLAUDE.md` that duplicates its `AGENTS.md` is not repeated. After a successful `read`, `write`, or `edit` call reaches a deeper directory, the next request includes the newly applicable instruction file; a changed file replaces its content, and a file that disappears or duplicates an earlier candidate produces a removal notice.

### Configuration

The defaults suit a typical checkout: `.git` marks the project root, `AGENTS.md` and `CLAUDE.md` are the base candidates, and `AGENTS.local.md` and `CLAUDE.local.md` are additive local overlays. Only `maxBytes` is required — it caps the complete rendered baseline so each deployment chooses its prompt budget explicitly.

```yaml
- name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

The accepted fields, at a glance:

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  maxBytes: number
  maxSourceBytes?: number
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
}
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | required | Cap on the complete rendered baseline message, in bytes |
| `maxSourceBytes` | `1048576` | Cap on one source instruction file before rendering |
| `projectRootMarkers` | `['.git']` | Directory names that mark the project root |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | Base file names loaded in each project directory |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | Local overlay file names loaded after the base files |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Directory containing the user-global `AGENTS.md` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-instructions) is the exhaustive source for every accepted field and its JSDoc.

### Observing the budget

Rendering keeps the most specific files first: it drops whole broader files before truncating the most-specific file, and emits a visible `Workspace instruction budget ...` notice naming the omitted and truncated paths. The rendered bytes never exceed `maxBytes`. An over-budget broad file is ignored; during refresh it is treated as temporarily unavailable rather than removed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The plugin is built on one principle: workspace instructions are durable conversation content, owned per agent and per session. Baseline and refresh messages are ordinary sourced `user/message` events, so they replay, compact, and resume exactly like other history, and model-visible state is always reconstructable from the session log. The plugin owns the complete `<system-reminder>` framing and every injected message reaches the model verbatim.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step listener, `tools/result` touch tracking, inbox composition |
| [`src/config.ts`](src/config.ts) | `Config` schema, budget resolution, baseline identity |
| [`src/files.ts`](src/files.ts) | Candidate discovery, project-root search, bounded streaming reads |
| [`src/render.ts`](src/render.ts) | Instruction rendering, budget truncation, change records |
| [`src/state.ts`](src/state.ts) | Durable message sources, version/digest cache, reconciliation |
| [`src/digest.ts`](src/digest.ts) | SHA-1 content identity and per-directory duplicate keys |
| — | No runtime invariant companion is published; replay intentionally tolerates unknown or malformed workspace sources, while focused pipeline tests own its private pending/cache state transitions. |

### Main flow

At the first eligible `agent/pre-step` of a session, the plugin composes the baseline and folds it into the entering batch right after the claimed messages. Successful first-party `read`, `write`, and `edit` calls contribute touches that bubble up through parent execution tokens; once the enclosing step is durable, a projection reconciles the visible session state against the inbox and queues additions, replacements, or removals. An unchanged path with an unchanged digest is never injected again. Discovery follows structured filesystem activity rather than shell navigation, because each local shell call starts a fresh process and parsing arbitrary shell syntax is not a reliable filesystem seam.

### Invariants

Every injected message carries a typed source with its change list; a complete baseline also carries an identity derived from normalized discovery, precedence, project-root, and budget configuration, and a matching durable message confirms a queued baseline. Model-visible text contains no hidden state markers, and literal `</system-reminder>` text anywhere in instruction content or model-visible metadata is escaped so repository-controlled text cannot close the plugin-owned frame.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the instruction-file format to the design decision and the exhaustive configuration.

- [Documentation standard](../../../docs/AGENTS.md) — what `AGENTS.md` instruction files contain and how they are maintained.
- [Workspace-context decision record](../../../.agents/notes/archived/feature/2026-06-24-workspace-context.md) — per-agent/session isolation and lifecycle rationale.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-instructions) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a> <a id="prompt-shape"></a>
## Model Experience

### Baseline context

#### What the model sees

At the first request, derived history contains one durable user-role message with the bounded user-global and project instruction chain in broad-to-specific order. Resume reuses that message when its visible baseline is compatible.

##### Baseline instruction template

```markdown
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

<user-global-instructions>

Instructions from: AGENTS.md

<project-instructions>
</system-reminder>
```

#### Token effect

The rendered baseline is appended once and remains in derived history until compaction. `maxBytes` bounds the complete message, broader files are omitted before the most-specific file is truncated, and an empty chain contributes zero tokens.

#### KV Cache effect

Append-only after the existing reusable prefix. Resume preserves reuse when the visible baseline identity is compatible; an incompatible identity appends a complete replacement, so discovery, precedence, project-root, or budget changes affect reuse only from that history position.

### Newly discovered scope context

#### What the model sees

After a successful first-party filesystem call reaches a deeper directory, the next request includes one retained sourced `user/message` with the newly applicable instruction file.

##### Additional instruction template

```markdown
<system-reminder>
Additional instructions from: packages/app/AGENTS.md

These instructions apply to work under `packages/app`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

<nested-instructions>
</system-reminder>
```

#### Token effect

Each discovered scope adds bounded history tokens until compaction. Unchanged content is suppressed by visible session state plus version/digest comparison, and PTC mode defers the same message until after the outer `run_code` result and its enclosing durable step.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Changed or removed instruction context

#### What the model sees

A changed file produces `Updated instructions from: <path>` plus its replacement content. A candidate that disappears or becomes a per-directory duplicate of an earlier candidate produces the removal notice below.

##### Removal notice

```markdown
<system-reminder>
Instructions removed: packages/app/AGENTS.md

The previously loaded instructions from this file no longer apply.
</system-reminder>
```

#### Token effect

Each confirmed change or removal is one retained history message bounded by `maxBytes`. Provider failures add no message, and an update omitted by the budget remains eligible for a later filesystem touch.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when instruction loading is a poor fit or needs operational awareness. They are current package constraints, not a task backlog.

- **Discovery follows structured fs tools, not shell navigation** — a `bash` command that changes directories does not trigger nested instruction discovery because shell syntax and per-call shell state are not a reliable filesystem seam.
- **Refresh is touch-driven** — there is no watcher; external edits become visible on the next successful first-party `read`, `write`, or `edit`, when resume reconciles a visible baseline, or when an entering pre-step restores a shadowed baseline.
- **Candidate semantics stay intentionally small** — lowercase names, `.claude/rules/`, and `@path` imports are not interpreted; project scopes load `AGENTS.local.md`/`CLAUDE.local.md` overlays by default, but the user-global `$DSH_HOME` scope has no local overlay and other custom names require explicit candidate configuration.
- **Per-directory dedup is content-based** — sibling candidates collapse only when byte-identical after trimming leading and trailing whitespace; a `CLAUDE.md` that symlinks its sibling `AGENTS.md` resolves to the same content and collapses like any duplicate, while a distinct real copy that has drifted from `AGENTS.md` loads in full alongside it.
- **Symlinked instruction files are followed across the trust boundary** — a candidate whose final component is a symlink is resolved and its target loaded, so a cloned repository can surface off-tree file content as lower-authority workspace guidance (it never overrides system, developer, or direct user instructions). Confine `ctx.fs` with the filesystem policy gate or an OS sandbox when loading untrusted repositories.
- **Instruction content is bounded, not summarized** — over-budget broad files are omitted and the most-specific file may be truncated; the plugin never asks a model to compress instruction prose.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
