# Agent Note: Tool output spill policy

Status: implemented

English | [中文](2026-07-08-tool-output-spill-files.zh.md)

## Problem

Tool outputs need bounded model-facing previews, but some oversized results are still useful later. A fetched page body or a verbose tool response should not consume the next model request in full, but the model should be able to inspect the complete formatted result later with existing file-reading tools.

Before this change the behavior was uneven. `dsh-bash-local` already writes complete stdout/stderr streams to private temp spill files when its in-memory tail overflows, but ordinary text tool results were returned inline unless the tool hand-rolled its own cap. The [tool result retention library](../../archived/architecture/2026-07-06-tool-result-retention-library.md) owns preview mechanics, but it does not own storage or an execution-pipeline policy that applies those mechanics to final tool results.

The shape matches the timeout policy design: a tool author declares a canonical value plus Native renderer, and a policy plugin enforces the deployment's default context budget on rendered content. Tool-specific early spill remains possible for provider acquisition bounds; tool-owned presentation spill may retain a complete acquired canonical value while replacing only presentation. The [canonical tool-output contract](2026-07-20-canonical-tool-output-contract.md) owns that split.

## Decision

A thin spill storage seam plus a default spill policy plugin, in a new `packages/spill/` group:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-spill` | Interface: `ctx.spillStore`, vocabulary types, no storage implementation. |
| `@deepseek-ai/dsh-spill-local` | Local backend: private, session-scoped file storage on the host filesystem. |
| `@deepseek-ai/dsh-spill-policy` | Tool-result policy plugin: wraps final text results after dispatch and replaces oversized results with a retained preview plus a spill locator. |

The tool-result Consumer is `dsh-spill-policy`, which consumes final tool results through the `tools/post-execute` waterfall. The model follows the backend-supplied retrieval hint for the returned locator. [Session-reference spill reuse](../bug-fix/2026-09-05-session-reference-spill-reuse.md) adds a direct storage consumer with separate preview, provenance, and failure semantics; it does not change the tool-result policy.

### Spill seam

The storage seam is minimal: save text and return a locator plus retrieval hint.

```ts ignore-check
interface SpillStore {
  saveText(input: SaveTextSpill): Promise<SpillRef>
}

type SpillSource = {
  kind: 'tool'
  toolName: string
  callId: ToolCallId
  label: string
} | {
  kind: 'session-reference'
  sessionId: SessionId
  label: string
}

interface SaveTextSpill {
  owner: { sessionId: SessionId }
  source: SpillSource
  suggestedName: string
  content: string
}

type SpillLocator = Branded<'SpillLocator'>

interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` is a [branded](../../../../packages/util/brand) model-facing handle returned by the backend. The local backend renders it as a filesystem path; a remote or database backend can render a URI, key, or command token. Consumers treat it as opaque and render it with `retrievalHint` instead of assuming `read` is always the right retrieval mechanism. `SpillOwner.sessionId` is the save-time storage namespace: forked sessions inherit existing spill locators from the seeded log without copying or re-owning them, and new spills after the fork use the child session id. A retention-period cleanup may expire old locators with other old session artifacts; the spill seam does not define a per-session cleanup policy.

`dsh-spill-local` owns storage details: session-scoped directory selection, safe names, path-traversal protection, the write, local artifact lifetime, and returning `{ locator, bytes, retrievalHint }`. It does not own tool-result replacement, model-facing preview policy, search, file inspection, or a seam-wide/per-session retention policy. Files land at `<root>/session-<hash>/<random>-<safeName>`, where `root` is a configured path or a lazily-created private (0700) per-process temp dir, the session subdir is a short `sha256(sessionId)` prefix, and the leaf is a random hex prefix plus the caller's `suggestedName` sanitized to one path segment (mirrors the JSONL backend's `encodeSegment`). The write is `open(path, 'wx', 0o600)` — exclusive and owner-only, so a planted symlink cannot redirect it. The locator is the path, and the retrieval hint tells the model it can use `read` or `grep` on that path. Its one-shot startup cleanup applies the backend-specific artifact lifetime described in the [local spill cleanup note](../../archived/architecture/2026-07-17-local-spill-startup-cleanup.md).

### Spill policy

`dsh-spill-policy` is a `tools/post-execute` result transformer with one configuration knob:

```ts ignore-check
interface Config {
  /** Omitted means no automatic spill policy. Present means apply to oversized plain text tool results. */
  maxInlineBytes?: number
}
```

When `maxInlineBytes` is omitted the plugin registers nothing (a true no-op). When set, it applies a default policy to final plain-text tool results:

1. Let the tool run normally, delegating via `next()` so a downstream listener settles the result first.
2. Flatten the accepted final `ContentBlock[]` only when it is entirely plain text; a result with any non-text block is left untouched.
3. If its UTF-8 byte size is at or below `maxInlineBytes`, leave it unchanged.
4. If it is larger, call `ctx.spillStore.saveText()` with the full final text.
5. Replace the model-facing result with a retained head/tail preview plus the spill reference.

The preview is an implementation default owned by the policy: a head/tail split of `maxInlineBytes` via the retention library's `TextRetainer`. Future config can expose preview sizing only after a second deployment needs it.

The replacement text is intentionally generic because the policy only knows the final formatted tool result, not the tool's internal resource:

```text
<retained preview>

(Omitted N bytes. Full formatted result stored at: /.../session-.../....txt. Use read with offset/limit, or grep this path to search within it.)
```

If `ctx.spillStore.saveText()` fails (permissions, ENOSPC, backend unavailable), or the call has no session owner, or no backend is loaded, the plugin logs the reason and returns the original result unchanged. Spill failure never turns a successful tool call into an `isError` result or hides the inline result.

The policy skips `read` to avoid a circular `read -> spill file -> read again` loop. Additional opt-out configuration is deferred until a real second tool needs it.

## Showcase: web_fetch

`web_fetch` is the first showcase because it returns a naturally large text result and needs no tool-specific spill code. The tool is ordinary:

```ts ignore-check
ctx.tools.register(defineTool({
  name: 'web_fetch',
  output: {
    schema: WEB_FETCH_RESULT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: formatFetchOutput(value) }],
  },
  async execute(args, exec) {
    const result = await ctx.web.fetch({ url: args.url }, exec.signal ? { signal: exec.signal } : undefined)
    return result
  },
}))
```

With `dsh-spill-policy` configured, a large formatted fetch result is automatically retained and spilled. A deployment demonstrates the behavior by setting the provider resource cap higher than the policy cap:

```yaml
- id: web-fetch-http
  name: '@deepseek-ai/dsh-web-fetch-http'
  config:
    maxBodyChars: 500000

- id: spill-local
  name: '@deepseek-ai/dsh-spill-local'

- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

This separation is important. `web-fetch-http` still owns resource caps (`maxResponseBytes`, `maxBodyChars`) to protect network, memory, and decoding work. `spill-policy` owns only the model-facing context cap after the result already exists. If the provider already returned `truncated: true`, the spill file contains the full formatted result the tool returned, not the full original webpage; the policy does not claim otherwise.

## Relationship to retention and early spill

Retention is separate from spill storage:

- `@deepseek-ai/dsh-output-retention` owns preview mechanics (`TextRetainer`, `ItemRetainer`, and omitted metadata).
- `@deepseek-ai/dsh-spill` owns saving final text and returning a locator plus retrieval hint.
- `@deepseek-ai/dsh-spill-policy` applies the default final-result policy in the tool pipeline, composing the two.

The final-result policy cannot replace tool-owned early spill. Some useful content is not present in final `ToolExecutionResult.content`:

- `bash` final output is already a tail plus a temp spill path; the complete stdout/stderr streams live in executor files.
- `subagent` final output is the child final answer, not the child rollout.
- Future tools may produce runtime artifacts that are never represented by their final `ToolExecutionResult.content`.

Those cases can consume `ctx.spillStore` directly in later work. They are not part of the first showcase.

## Non-goals

- This decision adds no model-facing `artifact_read` or `artifact_search` tool.
- This decision adds no per-tool retention configuration.
- No model-facing timeout/truncation arguments.
- No migration of `read` output into spill files.
- No replacement for provider/resource caps such as `web-fetch-http.maxBodyChars`.
- No bash temp-file normalization or subagent rollout capture in the first cut.

## Deferred

- `saveFile()` / `linkOrCopy` for existing executor spill files, needed for bash normalization.
- Tool-owned spill for subagent rollouts (`await run.result`, read in-process child session before `run.dispose()`, save JSONL).
- Per-tool opt-out or per-tool policy declarations if the built-in `read` skip is insufficient.
- Remote or database storage backends for ACP or remote environments where a local path is not meaningful.

Cleanup shipped for the local backend as a one-shot startup sweep, not tied to session deletion — see the [startup-cleanup Agent Note](../../archived/architecture/2026-07-17-local-spill-startup-cleanup.md). The seam still defines no per-session cleanup policy; retention is a backend concern.

## Testing

- `dsh-spill` unit tests pin the seam contract: registration as `ctx.spillStore`, one-implementation-per-context, and disposal release.
- `dsh-spill-local` unit tests cover `saveText`, `encodeSegment` sanitization (separators/tilde/whole-segment dots/empty), the session-hash directory, owner-only permissions, distinct paths per save, the configured/private root, and a storage-failure rejection.
- `dsh-spill-policy` unit tests drive real tools through `ctx.tools.execute`: disabled-mode no-op, oversized-text replacement, small/non-text passthrough, `read` skip, best-effort fallback (save failure / no backend / no owner), and downstream-composition (bounding a replaced result, preserving `additionalContexts`).
- `dsh-tool-web` integration drives `web_fetch` through `ctx.tools.execute` with the real `spill-local` backend + policy, proving the model-facing text changes only by the deliberate spill notice while the spill file holds the full formatted result.
- The `tui-agent` example loads `spill-local` + `spill-policy`, so its keyless Loader/PTY smoke exercises the real load path (the namespace-plugin export shape + `inject`).

## Consequences

The default policy only sees final formatted text. It cannot preserve provider-internal content that was already capped or runtime artifacts that were never part of the result. This is acceptable for the first cut because the showcase is final-result spill, not early spill; tool-owned early spill remains deferred work.

Returning real paths keeps the local backend simple and matches proven agent-tool behavior, while the seam itself only promises an opaque locator plus retrieval hint so remote backends can return non-file locators.

The local-backend value proposition depends on the existing `read`/`grep` tools being able to inspect the returned local path, even when the spill directory is outside the session cwd. That holds because the filesystem policy records observations and write guards but does not confine reads to the workspace. A future workspace-confinement policy must either allow local spill paths explicitly or use a non-file spill backend whose retrieval hint points at a supported reader.

**Snapshot gap.** No ACP snapshot scenario covers the transcript-visible `web_fetch` spill notice yet. The ACP snapshot harness replays keyless and cannot hit the live web, and a `web_fetch` spill requires a real over-cap HTTP body; a deterministic scenario would need a seeded loopback fetch target the replay tree does not currently wire (the examples do not load `tool-web` at all). The behavior is covered instead by the `dsh-tool-web` integration test against a loopback server. Closing the gap is follow-up work: wire `tool-web` + a seeded fetch target into the ACP example, then record a `web-fetch-spill` scenario.

The policy can become too large if it starts owning tool-specific semantics. It stays narrow: plain-text final results only. Tool-owned early spill remains future work.

## Alternatives considered

**Require each tool to opt in with a retention declaration.** Rejected: the goal is a default behavior similar to Claude Code's generic tool-result persistence. A single `maxInlineBytes` deployment knob is enough to prove the shape.

**Make `tool-results` a broad tool-result platform.** Rejected: a broad package name invites retention policy, result replacement, preview wording, search, and early spill into one seam. The shared storage part is smaller: save text and return a locator plus retrieval hint.

**Use `ctx.fs.writeText` or the model-facing `write` tool.** Rejected: workspace filesystem writes carry project-file semantics, write/edit policy, observation state, and user-facing side effects. Spill files are runtime artifacts, not model-authored workspace edits. The existing `read` tool may inspect them later, but creation belongs to the runtime spill seam.

**Let `web-fetch-http` fetch without caps and rely on spill-policy.** Rejected: spill-policy runs after the final tool result exists and cannot protect network, memory, or decoding resources. Provider resource caps stay mandatory.

**Merge retention into spill.** Rejected: retention and spill have different responsibilities. `TextRetainer`/`ItemRetainer` decide what preview is kept and what was omitted; spill storage only saves the final text the policy asks it to save.
