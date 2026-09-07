---
description: "The model-facing lsp tool: four read-only code-navigation operations with one-based UTF-16 cursor coordinates, bounded results, and hover text, for users and maintainers composing model code navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-lsp

English | [中文](README.zh.md)

## Summary

`dsh-tool-lsp` gives the model a single read-only `lsp` tool for precise code navigation over the LSP seam: go to a symbol's definition, find its references, jump to its implementations, or read hover documentation. The tool owns everything the model sees — name, schema, prompt guidance, result formatting, and UI presentation — and never depends on which language server backs a query. Positions are one-based UTF-16 cursor coordinates, which the tool converts to the seam's zero-based convention. Results are bounded location lists or normalized hover text with explicit no-result and truncation markers. Compose it with a provider such as `dsh-lsp-stdio` and the `dsh-lsp` seam to activate navigation.

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

An agent uses `lsp` when textual matches are ambiguous or before a change that needs precise definitions, implementations, or references; the tool's prompt guidance tells it to prefer `search`/`read` for ordinary navigation.

### The tool

`lsp` takes `operation` (`goToDefinition`, `findReferences`, `goToImplementation`, or `hover`), `file_path`, `line`, and `character`. `line` and `character` are positive one-based UTF-16 cursor coordinates; an off-symbol position may return no results. `findReferences` always includes the declaration, so impact analysis never misses the defining site. Provider choice, language id, workspace root, limits, timeout, and executable stay outside model input.

### What the model gets back

Navigation returns `path:line:character` locations grouped by file (one-based); hover returns normalized text or a no-hover notice. Empty locations and no hover are successful no-result responses. Results are capped first by `maxLocations` and then by `maxResultChars`, with omission and truncation markers inside the complete cap; the caps affect only presentation, not the canonical result value.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxLocations` | `100` | Largest number of rendered locations before an omission marker |
| `maxResultChars` | `16000` | Largest complete rendered result, including truncation metadata |
| `timeoutMs` | `60000` | Tool-call timeout budget enforced by `dsh-tool-call-timeout-policy`; covers the complete queued open/query/close lifecycle and is not model-configurable |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-lsp) is the exhaustive source for every accepted field.

### Failures and recovery

The tool requires a session workspace root (`header.cwd`) with no fallback; absence fails with `LSP_WORKSPACE_REQUIRED` before any query. When no provider handles the file's extension, the query fails with `LSP_UNAVAILABLE`; malformed provider payloads remain structured `LSP_MALFORMED_RESPONSE` errors. These surface to the model as error tool results it can read and route on.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and where the code realizes them; observable behavior is covered in [Use this package](#use-this-package).

### Design notes

- **Consumer-only.** The tool runtime-injects only `tools`, `lsp`, and `systemPrompt`, imports no provider, and passes only `exec.signal` to the seam.
- **Coordinate conversion.** `parseLspArgs` validates that `line` and `character` are positive integers and converts them to the seam's zero-based positions; rendered locations convert back to one-based form.
- **Canonical result passthrough.** The tool returns the seam's closed union (`{ kind: 'locations', locations, resolvedWorkspaceUri }` or `{ kind: 'hover', hover }`) so native renderers can inspect every acquired location and zero-based range directly.
- **Execution-world URI rendering.** `renderUri` resolves a `file:` URI against the provider's canonical workspace URI — workspace-relative inside it, URI-derived absolute outside it, verbatim when malformed or not `file:` — never applying host-platform path rules to the session cwd.
- **Caps after rendering.** `maxLocations` bounds the item count first, then `maxResultChars` bounds the complete rendered text including its omission or truncation marker.
- **Generic search-card presentation.** `presentLspCall` renders a `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` view; the args-derived title carries the operation and one-based cursor, and follow-along focuses the queried line while the title preserves the column.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, tool registration, system-prompt section, execution |
| [`src/render.ts`](src/render.ts) | Pure formatting, coordinate conversion, URI resolution, result caps, UI presentation |
| [`src/session-cwd.ts`](src/session-cwd.ts) | Workspace root from the session `header.cwd` |
| — | No runtime invariant companion is published; this stateless adapter contributes one tool and prompt section, while query lifecycle and result relations remain owned by the tool and LSP seams it composes. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the model-facing surface to the seam and the provider.

- [LSP navigation subsystem](../../../docs/subsystems/lsp.md) — operations, coordinates, requests and results, and `LspError` codes.
- [dsh-lsp](../lsp/README.md) — the seam this tool queries.
- [dsh-lsp-stdio](../lsp-stdio/README.md) — the stdio provider that answers these queries.
- [lsp group map](../README.md) — the three-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

One system-prompt section (first-party order 2200) positions LSP as a precision aid with the following text:

##### Verbatim guidance

```markdown
Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.
```

#### Token effect

Fixed guidance cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schema

#### What the model sees

The model sees the generated [`lsp` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp).

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

File-grouped `path:line:character` location lines or normalized hover text, capped first by `maxLocations` and then by `maxResultChars`; omission and truncation markers are included inside the complete character cap. These caps affect only Native/model presentation, not the canonical value. Empty results use distinct `No results.` / `No hover information.` lines.

#### Token effect

Capped per tool result by `maxResultChars`, with `maxLocations` additionally bounding navigation item count.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic search card — `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` — whose args-derived title carries the operation and one-based cursor; follow-along focuses the queried line while the title preserves the column.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **UTF-16 cursor coordinates** — columns are exact for the protocol but hard for a model to count around non-BMP characters; an off-symbol position may return empty results, so the prompt explains the convention without encouraging broad LSP use.
- **No cross-server completeness promise** — supported servers may return empty or partial results depending on indexing readiness; the tool promises no completeness across languages or servers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
