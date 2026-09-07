# Agent Note: Canonical tool output contract

Status: implemented

English | [中文](2026-07-20-canonical-tool-output-contract.zh.md)

## Problem

Tool bodies previously authored model-facing `ContentBlock[]` directly, optionally wrapping it with opaque `meta`. Native function calling therefore had a usable human projection, but a programmatic caller had no stable domain value: PTC mode flattened the blocks back into a string, dynamic tools repeated the content shape, and policy could replace presentation without any way to distinguish that change from replacing the operation's result. Several capability seams already returned richer provider values only to discard them at their model-facing tool boundary.

The durable session contract made that presentation authoritative for replay, but persisting every rich intermediate value would enlarge logs, expose implementation data to compaction and migration, and incorrectly turn an execution-local API into session format. The foundation instead needs one typed value during execution and an explicit projection into the existing durable/model-facing content.

## Decision

Every tool declares a mandatory canonical output and returns only the value described by it:

```ts ignore-check
output: {
  schema: OutputSchema
  render(args, value): ContentBlock[]
  presentationMeta?(args, value): JsonValue
}
```

`defineTool` infers the body return and both projectors from the unified `ValueSchemaSpec`. Raw and dynamic definitions provide the compiled `JsonSchemaNode` form. Registration rejects a missing declaration or unsupported raw schema; there is no content-return compatibility path.

For each successful dispatch the registry snapshots the returned value as lossless `JsonValue`, validates it against `output.schema`, deep-freezes it, then invokes the pure renderer and, for a direct surface call, the optional metadata projector. Renderer, projector, schema, or lossless-JSON failures are contained as ordinary `ToolOutputError` results. An around `tools/execute` wrapper receives and returns the canonical success/failure union; a wrapper-authored success is normalized again through the resolved tool's output declaration instead of trusting independently authored content. Each canonical result is tied to the immutable dispatch token that created it, so returning a cached result from another call or tool triggers normalization under the active declaration rather than bypassing it.

```ts ignore-check
type ToolExecutionResult =
  | { isError: false; value: JsonValue; content: ContentBlock[]; meta?: JsonValue; additionalContexts?: HookContext[] }
  | { isError: true; error: { message: string; info?: { name: string; code: string } }; content: ContentBlock[]; meta?: JsonValue; additionalContexts?: HookContext[] }
```

`tools/post-execute` has two mutually exclusive successful projections. Replacing `content` changes only Native/model presentation and preserves the canonical value and metadata. Replacing `value` revalidates the replacement and recomputes both presentation projections. A block removes the value and becomes a failure. Content replacement is therefore not a confidentiality mechanism: policy that must prevent programmatic access blocks the call or replaces the value.

Canonical values are execution-local. The agent loop persists `tool/result` with only `content`, `error`, and optional `meta`; PTC mode's `tool/code-dispatch` persists the sub-call's rendered `content` and `isError`. Neither event stores the canonical intermediate value, so replay reproduces presentation but cannot reconstruct the programmatic result. When a tool declares `presentationMeta`, it is computed only for a direct surface call; a nested Code dispatch gets no metadata. The Client can derive [nested terminal cards](../bug-fix/2026-09-05-nested-terminal-cards.md) from raw arguments and rendered content without that metadata. The outer `run_code` card instead reads final post-policy content and declares no presentation metadata. Generic and tool-owned spill projections similarly skip nested dispatches, whose canonical value never enters model context.

The first-party tools preserve their existing Native text while returning domain DTOs:

| Tool family | Canonical value |
|---|---|
| `read` | `{ path, offset, lines: [{ number, text }], totalLines }` |
| `write` | `{ path, operation: "create" | "update", before: string | null, after }` |
| `edit` | `{ path, before, after }` |
| `glob` | `{ paths: string[] }` |
| `grep` | `{ matches: [{ path, lineNumber, line }] }` |
| `web_search` / `web_fetch` | The normalized `WebSearchResult` / `WebFetchResult` |
| `lsp` | `{ kind: "locations", locations, resolvedWorkspaceUri }` or `{ kind: "hover", hover }` |
| `bash` | `{ kind: "background", jobId }` or `{ kind: "foreground" } & ShellRunResult` |
| `terminal_open` / `terminal_list` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` | Public session snapshots, bounded read/send DTOs, signal/close outcomes, or a background job handle |
| `job_output` / `job_list` / `job_kill` | Public task snapshots without owner or notification bookkeeping |
| `subagent` | Background job handle or `{ kind: "foreground", runId, output: JsonValue[] }` |
| `workflow` / `ralph` | `{ runId, agentsStarted, result: JsonValue }` |
| `skill` | `{ name, provider, resourceBase?, content }` |
| `todo_write` | `{ todos, counts }` |
| `ask_user_question` | `{ answers: [{ id, selected, custom? }] }` |
| `exit_plan_mode` | `{ approved: true }` |
| `cordis_inspect` / `cordis_mount` / `cordis_unmount` | Inspection text or typed temporary-Plugin handles |
| `structured_output` | `{ recorded: true }` |
| `run_code` | `{ logs: string[], result?: JsonValue }` |

Provider and executor acquisition limits remain real limits on the canonical value. Formatting-only limits belong in `render`; `glob` and `grep`, for example, keep every acquired item in `value` while their Native projection retains and best-effort spills the configured first page. Generic spill prepends and delegates its post-execute listener so an ordinary tool-owned asynchronous projection completes before generic byte bounding regardless of plugin load order. Filesystem mutations derive replayable diff metadata from `args` and the canonical before/after value rather than returning UI state from the body.

MCP bridges preserve protocol blocks through `McpResult<{...}> = { content: JsonValue[]; structuredContent? }`. An advertised `outputSchema` is enforced when it belongs to the supported raw subset; unsupported schemas fall back to `JsonValue` rather than pretending to validate them. Native rendering still uses the existing MCP-to-`ContentBlock` projection, and MCP `isError` becomes a failed tool result.

## Alternatives considered

- **Return rendered text to PTC mode:** rejected because callers would continue scraping prose for job ids, mount ids, paths, and structured provider results.
- **Persist canonical values on `tool/result`:** rejected because nested execution values are not model history, need not survive replay, and would create a session-format and storage commitment unrelated to Native reconstruction.
- **Let tools return both value and content:** rejected because two author-owned results can disagree and policy cannot state which one is authoritative. The renderer makes presentation a deterministic projection of the validated value.
- **Treat content replacement as value redaction:** rejected because presentation and programmatic access are different consumers; hiding only the former would create a false security boundary.
- **Require object-rooted tool outputs:** rejected because scalar, array, and null results are legitimate JSON APIs. Object-rooting remains a consumer rule for caller-defined subagent/workflow structured output.

## Consequences

Native and replay behavior remains content-first and byte-compatible, while execution-time callers can use a validated domain value without parsing that content. Failures have one required message plus optional internal class/code information, successful and failed outcomes are discriminated, and a failed result can never promise a value. Tool authors must design the value and Native projection together; the extra declaration is intentional because it prevents accidental programmatic contracts from being inferred from prose.

Intermediate values remain bounded only by the producing capability and process memory. Their omission from the log means replay cannot recover them, and a content-only post policy does not hide them. These are explicit properties of the execution-local contract, not accidental gaps.
