# Agent Note: LSP capability seam and model-facing query tool

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-15-lsp-capability-seam.zh.md)

## Problem

The harness has text search and file reads, but neither identifies a program symbol. A textual match cannot reliably distinguish two same-named functions, follow an import alias, connect an interface to its implementations, or report an inferred type. Before changing code, an agent therefore lacks the semantic navigation that a human gets from an editor's language server.

LSP support has three owners: the model needs a stable query schema, the harness needs provider selection and normalized results, and the local implementation needs process, JSON-RPC, workspace, synchronization, and filesystem behavior. Combining them would bind the model contract to local subprocesses and obstruct remote or sandbox-native providers.

Many language servers behave best when the queried document is opened with current text. A compatible agent client must bound that state, define whether its source read is a model observation, and keep the document snapshot in the same filesystem namespace as the server's workspace index.

## Decision

Add LSP as a three-package capability seam with one read-only model tool and one generic local provider implementation:

1. `@deepseek-ai/dsh-lsp` at `packages/lsp/lsp` owns `ctx.lsp`, provider registration and selection, normalized requests/results, execution control, and structured LSP errors.
2. `@deepseek-ai/dsh-lsp-stdio` at `packages/lsp/lsp-stdio` adapts configured stdio language servers to the seam. One plugin instance accepts a named server table and registers one isolated provider for each command and extension-to-language-id mapping.
3. `@deepseek-ai/dsh-tool-lsp` at `packages/lsp/tool-lsp` owns the model-facing `lsp` schema, prompt guidance, argument validation, result limits and formatting, and transport-neutral UI presentation.

`dsh-lsp-stdio` is a generic host, not a language-server catalog or installer. Deployments explicitly configure commands and mappings; future presets belong in composition plugins or `cordis.yml` overlays.

The model and seam expose exactly `goToDefinition`, `findReferences`, `goToImplementation`, and `hover`; no arbitrary JSON-RPC method escapes through `ctx.lsp`. These operation literals match Claude Code's familiar camelCase names while the tool name and `file_path` field remain harness-owned.

The prompt positions LSP as a precision aid: `Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references.`

## Package and ownership boundaries

`dsh-lsp` registers providers by branded id and extension-to-language-id mapping. `registerProvider()` atomically reserves the id and every normalized extension: invalid input or any conflict publishes nothing, and its disposer releases all reservations. Provider plugins register through `ctx.effect()`. Selection is per query and order-independent; no match returns a structured unavailable error. The first version has no glob, language-id, or explicit route selector and no statically declared operation capabilities.

The seam exposes one `query(request, signal?)` operation because no fields need implementation defaulting: `workspaceRoot` is required, `languageId` comes from the registration, and consumers own timeouts and result limits. `query()` selects and derives without hidden `??` fallbacks, leaving no executable spec to resolve. `dsh-tool-lsp` validates model arguments and passes only `exec.signal` as a bare `AbortSignal`, matching web and keeping `dsh-lsp` independent of `dsh-tools`. Removal before selection fails as unavailable; later disposal follows the selected provider's cancellation lifecycle without rerouting.

The contract shape:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
type LspProviderId = Branded<'LspProviderId'>

interface LspPosition {
  readonly line: number
  readonly character: number
}

interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

interface LspQueryRequest {
  readonly operation: LspOperation
  readonly filePath: string
  readonly position: LspPosition
  readonly workspaceRoot: string
}

interface LspProviderQuery extends LspQueryRequest {
  readonly languageId: string
}

type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly { readonly uri: string; readonly range: LspRange }[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: { readonly contents: string; readonly range?: LspRange } | null }

interface LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}

interface LspService {
  registerProvider(provider: LspProvider): () => void
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}
```

Mapping keys normalize to lowercase, leading-dot extensions selected from `filePath`'s final extension; language ids only synchronize documents. Seam positions and ranges are zero-based UTF-16. `findReferences` always includes declarations: providers enforce this internally, the local mapping sets `context.includeDeclaration: true`, and callers get no flag. Closed result unions normalize navigation to locations and hover to content or `null`; navigation results carry the provider's canonical workspace URI so consumers relativize file URIs in the execution world's namespace. The seam exposes no protocol types, process or document controls, or generic request escape hatch.

`dsh-lsp-stdio` owns server configuration, JSON-RPC, process and transient-document state, and protocol translation. It reads through `ctx.fs` and launches through `ctx.subprocess`, depending on their Service Definition packages rather than concrete providers; the [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md) owns that pairing. The server-table key is its provider id. The plugin resolves every server-local setting before registration, rolls back earlier registrations if a later mapping is invalid or conflicts, and retains an independent process pool per provider. `dsh-tool-lsp` runtime-injects only `tools`, `lsp`, and `systemPrompt`, obtains the workspace from `exec.agent?.session.header.cwd` through a package-local `sessionCwd(exec)` helper matching the filesystem tools' lookup, and imports no provider.

## Model-facing contract

The single `lsp` tool accepts:

```ts
interface LspToolInput {
  readonly operation: 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
  readonly file_path: string
  readonly line: number
  readonly character: number
}
```

`line` and `character` are positive, one-based UTF-16 cursor coordinates; the tool converts them to the seam's zero-based `LspPosition` and converts rendered locations back. `findReferences` includes declarations so impact analysis does not omit the defining site. Provider, language id, workspace root, limits, timeout, initialization, and executable remain outside model input.

The tool requires `workspaceRoot` from session `header.cwd`, with no fallback; absence fails as `LSP_WORKSPACE_REQUIRED` before querying or startup. The local provider resolves relative paths against that root and accepts absolute paths directly; both forms are canonicalized and rejected before startup when the target is outside the canonical workspace.

Locations render as stable, file-grouped `path:line:character` entries without applying harness-host path rules. A valid `file:` URI becomes a relative path inside the provider's canonical workspace URI or a URI-derived absolute path outside it; malformed and non-`file:` URIs remain verbatim. `maxLocations` defaults to `100` and reports omitted items; `maxResultChars` defaults to `16_000` and bounds every complete rendered result, including its truncation metadata. Empty locations and `null` hover are successful no-result responses; missing or malformed server payloads fail with structured `LSP_MALFORMED_RESPONSE` errors.

The transport-neutral presenter uses `{ card: 'generic', kind: 'search', title, locations: [{ path: file_path, line }] }` with an args-derived operation/cursor `title`. Because `FileLocation` has no character, follow-along focuses the input line while the title preserves the cursor; presentation remains pure.

## Timeout ownership

`dsh-tool-lsp` attaches one configurable `timeoutMs` budget, default `60_000`, to the tool definition. `dsh-tool-call-timeout-policy` enforces it and supplies `exec.signal`, which reaches `ctx.lsp.query`; the budget covers the complete queued open/query/close lifecycle and is not model-configurable.

The seam and provider add no startup or request deadline. Non-tool callers therefore receive no hidden timeout and must supply an `AbortSignal`, using `deadline()` when they need a budget.

Provider disposal occurs outside tool execution, so `dsh-lsp-stdio` keeps `shutdownTimeoutMs` (default `5_000`) for `shutdown`/`exit` and `killGraceMs` (default `2_000`) for both request-cancel grace and SIGTERM-to-SIGKILL escalation; the same bounds govern failed-instance cleanup. Timer values above Node's `2_147_483_647` ms scheduling range fail at load. The provider uses `deadline()` and `timeoutOf()` but owns request cancellation, process signals, and awaiting close because timeout notification does not terminate work.

## Workspace, filesystem, and document synchronization

`dsh-lsp-stdio` canonicalizes and reads through `ctx.fs` in the language server's execution world. It requires the workspace target to be a directory, rejects out-of-workspace sources through provider-owned containment, consumes `streamText`, and enforces `maxDocumentBytes` as chunks arrive; the provider retains regular-file validation and UTF-8 decoding while the protocol consumer owns its document limit. It fuses caller cancellation with provider disposal across each filesystem operation, tracks workspace lookups before they enter a queue, and awaits those lookups during disposal. It does not emit `fs/observed`: only the LSP result is model-visible, so the query does not satisfy read-before-write policy.

The `read` tool is unsuitable source because its output is windowed, numbered, transcript-visible, and observed. Reading in `tool-lsp` would also assign provider-specific synchronization to the consumer and preclude non-local providers.

The local provider uses a compatibility-first transient-open sequence for every query. It accepts legacy `textDocumentSync` `Full` or `Incremental`, or options with `openClose: true`; omitted, `None`, or explicitly incompatible synchronization fails as unsupported before `didOpen`.

1. Resolve and contain the source through `ctx.fs`, then stream its current text through the same provider while enforcing the document byte limit.
2. Send `textDocument/didOpen` with version `1`, full text, and the configured language id. Its write remains abortable; failure or cancellation invalidates the instance and awaits bounded process termination before the pool can reuse it.
3. Send the requested `textDocument/definition`, `textDocument/references`, `textDocument/implementation`, or `textDocument/hover` request.
4. If `didOpen` succeeded, attempt `textDocument/didClose` in `finally` after the request settles or aborts. A close-write failure does not replace the settled result or error, but invalidates the instance and awaits bounded process termination.

Documents close after each call, so the first version needs no `didChange`, `didSave`, content cache, mutation listener, or document LRU. One abortable per-workspace provider queue serializes source-read/open/query/close lifecycles, so a waiting query reads current bytes only when its turn starts; the instance also keeps protocol lifecycles serialized. Distinct workspaces may run in parallel. The server's workspace index remains responsible for closed files reached from the source.

The canonical workspace target must be a directory. Its target key supplies pool identity, its process path supplies cwd, and its provider-owned `file:` URI supplies `rootUri` and the sole `workspaceFolders` entry; aliases share an instance when the filesystem provider resolves them to one key. Result locations may be external, but an external path cannot become a query source. A filesystem that cannot share paths with the mounted subprocess provider is a composition error, not a reason for another LSP package.

## Local server lifecycle and protocol behavior

`dsh-lsp-stdio` lazily single-flights one server per `(provider id, canonical workspace target)`. At load it calls `ctx.subprocess.resolveExecutable()` with the configured environment, failing before registration if unavailable; first query launches through raw protocol pipes with no shell and a bounded collected stderr tail. `maxMessageBytes` defaults to `16_000_000`, `maxStderrBytes` to `1_000_000`, and `maxDocumentBytes` to `4_000_000`. A crash fails the active query without replay; a later query may replace the process. Each query starts at most one process, so the MVP has no cross-request restart counter.

Initialization uses `processId: null` because the client and server may inhabit different process namespaces. It advertises `general.positionEncodings: ['utf-16']`, `workspace: { workspaceFolders: true, configuration: true }`, `textDocument.hover.contentFormat: ['markdown', 'plaintext']`, and `linkSupport: true` for definition and implementation, with no dynamic registration. Returned operation and synchronization capabilities are authoritative. An omitted server `positionEncoding` defaults to `utf-16`; any other value is a protocol error. Configuration may supply initialization options and `workspace/configuration` responses, but the client rejects `workspace/applyEdit` and never executes commands or edits.

Navigation maps `Location` directly and `LocationLink` from `targetUri` plus `targetSelectionRange`. Positions must be nonnegative integers. Hover normalization accepts only valid `MarkupContent` and `MarkedString` shapes, preserves string values, renders language-tagged values as fenced code, and joins arrays with one blank line. The model-facing tool applies `maxResultChars` after rendering.

Abort reaches every query phase and sends `$/cancelRequest` once an id exists. An unresponsive server is terminated and awaited without collateral active work because the instance is serialized. Disposal rejects and cancels work, attempts graceful shutdown, escalates through bounded termination, and awaits quiescence.

## Deliberately deferred API

Symbols are deferred because they need different schemas and overlap read/search; a future workspace-symbol tool must accept a search query. Call hierarchy is deferred because support is uneven, and `prepareCallHierarchy` remains an internal prerequisite rather than a model operation.

Diagnostics need separate freshness, accumulation, and transcript rules. Mutations such as rename, code actions, and formatting require separate tools with preview, permission, and write-policy integration.

The provider trusts its configured server. Its filesystem visibility and process confinement are exactly those of the mounted execution world; LSP adds no independent sandbox policy.

## Alternatives considered

**Copy Claude Code's unified schema.** Its cursor operations validate the core use case, but symbols and call hierarchy need different arguments. Copying all nine operations would freeze speculative surface, so the seam aligns only on the four semantic queries.

**Let providers register tools.** Loaded servers would then control model schema and prompts, preventing one stable contract across local and remote providers.

**Expose arbitrary LSP methods.** A JSON-RPC escape hatch would leak protocol payloads and admit unreviewed mutation or command execution; the operation union stays closed.

**Expose `resolve(request)` / `query(spec)`.** With no defaulted fields, resolution would only expose provider selection, and a public spec could outlive provider disposal or replacement. One operation keeps selection and invocation atomic to the registration lifetime.

**Wrap the signal in an LSP execution-context object.** Web passes a bare `AbortSignal`; wrapping this single field would add unexplained asymmetry. `query()` gains a context object only when another field requires it.

**Read through the model-facing `read` tool.** Rejected because tool output is windowed, numbered, transcript-visible, and observed. The provider consumes streamed full text directly through the same `ctx.fs` execution world used by its subprocess.

**Keep documents open.** Mirroring edits requires version ownership, all-path `didChange`, HMR recovery, eviction, and stale-state rules. Transient opens avoid that MVP state machine.

**Configure phase timeouts.** Nested timers create competing classifications and fresh budgets. One caller-owned deadline covers query work; only out-of-call teardown keeps local bounds.

**Query without `didOpen`.** Although permitted, support is inconsistent and may use stale server state. Transient open supplies an explicit current snapshot.

**Add routes or select the first match.** Registration order and HMR timing are not product semantics, while a route table duplicates unique extension ownership. Overlaps therefore fail registration.

**Run concurrent queries in one instance.** If cancellation fails, terminating the shared process would kill unrelated work. Per-instance serialization limits that blast radius; instances remain parallel.

**Ship presets or PATH discovery.** A catalog would make the generic host own language policy, while discovery cannot infer arguments, language ids, or initialization. Deployments configure providers explicitly; composition plugins may package presets.

## Testing

- Package tests pin the three-package dependency direction, runtime injections, and `ctx.lsp`-only communication.
- Tool tests pin the four operations, coordinate validation, configured bounds and omission markers, prompt, and UI presentation.
- Registry tests pin atomic reservation/release, order-independent selection, and structured unavailable, disposed, conflict, and unsupported-operation errors.
- Fake-stdio tests pin exact initialization capabilities, four protocol mappings, `Location`/`LocationLink` and hover normalization, and `findReferences` mapping to `references.includeDeclaration`.
- Synchronization tests pin UTF-16 negotiation and conversion, supported and rejected `textDocumentSync` forms, blocked and failed open writes, balanced transient open/close, close-write failure, and malformed-response rejection.
- Timeout tests pin one `TOOL_TIMEOUT` budget, unclassified upstream cancellation, no hidden LSP deadline, and bounded awaited teardown.
- Lifecycle tests pin startup single-flight, complete-lifecycle serialization with fresh queued source reads, cross-workspace parallelism, abortable queues, crash replacement without replay, failed-stdin teardown, and quiescent disposal.
- Filesystem-host tests pin session-cwd requirements, provider-owned containment and URI rendering, bounded document reads, unformatted source, and no `fs/observed` event.
- A keyless pinned TypeScript real-server e2e exercises all four operations; runnable configuration uses the same explicit provider mapping.
- Snapshots cover model-visible schema, prompt, results, and omissions; a built-artifact smoke test covers framing and cleanup.
- Package and architecture docs cover configuration, security boundaries, and search/read guidance; the new `packages/lsp/` group is added to the AGENTS.md repository-layout block, the packages/README.md group table, and architecture.md in the same change.

## Consequences

Language servers vary in method support, capability interpretation, and indexing readiness; LSP has no universal “index complete” signal. Servers without compatible transient-open synchronization are unsupported even if closed-document queries work. Supported servers may still return empty or partial results, so the tool promises no cross-server completeness. The pinned TypeScript e2e establishes one compatibility floor, not a cross-language claim.

Transient opens repeat parsing and notifications. Per-instance serialization increases latency under parallel agents, and long-lived workspace processes consume memory until disposal.

Extension ownership is exclusive within one runtime. Two providers cannot both claim `.ts`, even with different language ids; this is a conscious MVP limit. The intended extension is a deployment-configured selector above registrations that can relax exclusive reservations without adding provider choice to model input or changing `LspProvider.query`.

UTF-16 cursor columns are exact for the protocol but difficult for a model to count around non-BMP characters. Invalid or off-symbol positions may produce empty results, so error text and prompt examples must explain the coordinate convention without encouraging broad LSP use.

The paired filesystem/subprocess providers align the query snapshot with the server index but do not make a trusted language server safe. Canonical containment rejects query sources outside the workspace at resolution time, but stream opening does not add stable-handle identity across a concurrent path replacement; the server itself receives the execution world's configured authority and may read other paths or use caches.
