# Agent Note: Filesystem tool schemas — model-facing read/write/edit shapes

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-17-filesystem-tool-schemas.zh.md)

## Problem

[The filesystem capability-seam Agent Note](../architecture/2026-06-17-filesystem-capability-seam.md) defines the filesystem capability seam (`ctx.fs`), the package split (`dsh-fs`, `dsh-fs-local`, `dsh-tool-fs`, plus the `dsh-fs-observation-policy` policy plugin), and the observed-file/stale-version policy for read-before-write/edit checks — which the [split-fs-seam](../simplification/2026-06-26-fsspec-style-fs-seam.md) and [event-gate](../architecture/2026-06-26-file-context-as-event-gate.md) Agent Notes moved off `ctx.fs` into the `dsh-fs-observation-policy` plugin on the `fs/*` event gate. The remaining decision for the first filesystem tool delivery is the model-facing schema: what arguments the model sees for `read`, `write`, and `edit`.

The schema must be small, yet stable enough that local/remote/sandboxed filesystem backends do not require model-facing churn, and must avoid importing every option from reference systems. Claude Code and OpenCode expose similar core file tools but differ in naming style and extra flags; this decision picks the minimal shared surface.

## Decision

`@deepseek-ai/dsh-tool-fs` exposes these three model-facing tools in the first filesystem suite:

| Tool | Our schema | Claude Code | OpenCode | Notes |
|---|---|---|---|---|
| `read` | `read(file_path, offset?, limit?)` | `Read(file_path, offset?, limit?, pages?)` | `read(filePath, offset?, limit?)` | Files only; 1-indexed `offset`; no image/PDF/multimodal support in the first pass. |
| `write` | `write(file_path, content)` | `Write(file_path, content)` | `write(content, filePath)` | Creates or overwrites UTF-8 text. Under the default fs-observation-policy, updates to existing files require a prior observation; new-file creates do not. |
| `edit` | `edit(file_path, old_string, new_string, replace_all?)` | `Edit(file_path, old_string, new_string, replace_all?)` | `edit(filePath, oldString, newString, replaceAll?)` | Literal string replacement; unique match required by default; under the default fs-observation-policy requires a prior observation (any windowed read counts). |

The schema uses snake_case field names (`file_path`, `old_string`, `new_string`, `replace_all`) to align with Claude Code and with existing DeepSeek Harness tool-schema examples. The Consumer package translates these model-facing names into `ctx.fs` calls and `fs/*` event dispatches.

## Tool schemas

### `read`

`read` inspects a UTF-8 text file and returns line-numbered content.

Arguments:

- `file_path: string` — required. Path to read, resolved by `ctx.fs`.
- `offset?: number` — optional. 1-based first line to return. Defaults to the first line.
- `limit?: number` — optional. Maximum number of lines to return. Defaults and caps are implementation details of `dsh-tool-fs` / `ctx.fs`.

Non-goals for the first pass:

- No PDF `pages` argument.
- No image or multimodal file reads.
- No directory listing through `read`; if needed, listing becomes a separate future tool.

### `write`

`write` creates or fully replaces a UTF-8 text file.

Arguments:

- `file_path: string` — required. Path to write, resolved by `ctx.fs`.
- `content: string` — required. Full UTF-8 text content to write.

Under the default fs-observation-policy, updating an existing file with `write` requires a prior observation (a read/write/edit) of that file by the same execution context; the `dsh-fs-observation-policy` plugin supplies the observed version as the stale guard on `fs/write-intent`. Creating a new file does not require a prior observation. With the policy plugin absent, `write` is an unconditional bare-provider create-or-overwrite.

The schema does not expose `expected_hash`, `expected_version`, or `create_only` as model-facing parameters. Stale-version checks are driven by backend-produced versions and the policy plugin's observed state, not by asking the model to copy version tokens through the schema.

### `edit`

`edit` updates an existing UTF-8 text file by replacing literal text.

Arguments:

- `file_path: string` — required. Path to edit, resolved by `ctx.fs`.
- `old_string: string` — required. Literal text to replace. Empty strings are invalid in the first pass.
- `new_string: string` — required. Literal replacement text; an empty string deletes the match.
- `replace_all?: boolean` — optional. Defaults to false. When false, `old_string` must identify exactly one match.

`edit` requires a prior observation of the file in the same execution context (any windowed read counts — authorization is version freshness, not a full-view requirement), or a prior write/edit by that context. The `dsh-fs-observation-policy` policy plugin derives the owner and supplies the recorded version as the stale guard; the provider's mutation lock enforces it.

The first pass rejects Codex-style patch grammars and multi-mode edit APIs. It uses one strict literal replacement mode so the model-facing contract stays simple and the backend can own exact-match, duplicate-match, line-ending, and stale-version semantics.

## Result shape

The first implementation formatted `ContentBlock[]` in `execute`. The [canonical tool-output contract](../architecture/2026-07-20-canonical-tool-output-contract.md) now keeps `ctx.fs` result facts as the tool's validated value and derives the same model text through `output.render`; file-state recording/refreshing remains on `ctx.fs`.

Default native projections:

| Tool | Structured `ctx.fs` outcome consumed by `tool-fs` | Default model projection |
|---|---|---|
| `read` | returned lines, returned line count, total line count, target display path, file version, partial-view flag | line-numbered text plus pagination footer |
| `write` | create/update operation, target display path, new file version | concise create/update success text |
| `edit` | replacement count, replace-all flag, target display path, new file version | concise edit success text |

The structured outcome does not restate model arguments such as `file_path`, `old_string`, or `content` unless the backend has resolved them into new information such as `displayPath`, `targetKey`, or a new version. Token-conscious truncation is part of the model projection, not the backend's canonical result.

## Deferred

The following are deliberately out of scope for the first filesystem schema pass:

- Model-facing `expected_hash`, `expected_version`, or `create_only` parameters.
- Directory listing, glob, grep, and search tools.
- Binary-safe read/write operations.
- PDF/image/multimodal `read`.
- PTC mode projection values for filesystem tools.
- A canonical edit diff format.

## Testing

Schema tests pin the required/optional argument set per tool, empty-`old_string` rejection, the `replace_all` default, the snake_case field names, description prose that states the observation policy, and root-plugin suite registration; integration tests execute all three tools through `ctx.tools.execute()` against the real `dsh-fs-local` provider and verify the model arguments translate into the expected `ctx.fs` calls and `fs/*` dispatches.

## Alternatives considered

- **A Codex-style patch grammar or multi-mode edit API** — rejected: one strict literal replacement mode keeps the model-facing contract simple and lets the backend own exact-match, duplicate-match, line-ending, and stale-version semantics.
- **camelCase argument names (OpenCode's style)** — snake_case aligns with Claude Code and the existing harness tool-schema examples, and naming is public API once shipped.
- **Model-facing `expected_hash` / `expected_version` / `create_only` parameters** — rejected: stale checks are driven by backend-minted versions and the policy plugin's observed state, never by fragile model-copied tokens.

## Consequences

**The first schema is intentionally smaller than Claude Code's.** Dropping PDF pages, multimodal read, rich grep/list flags, and expected hash fields keeps the implementation focused, but users may ask for those quickly. They arrive as separate Agent Notes or focused follow-ups rather than overloads of the initial schema.

**No explicit model-facing stale guard.** The schema does not ask the model to provide an expected hash/version. That is intentional: stale checks come from backend-produced versions and the `dsh-fs-observation-policy` plugin's observed state, not from fragile model-copied tokens. Filesystem safety failures surface through structured `FsError` codes owned by `dsh-fs`, not through model-supplied version fields.

**Naming becomes public API.** Once shipped, changing `file_path` to `filePath` or `old_string` to `oldString` would churn prompts, examples, and downstream clients. This Agent Note chooses snake_case up front and treats it as the stable model-facing contract.
