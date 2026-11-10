# LSP navigation

English | [中文](lsp.zh.md)

The LSP seam — a [capability seam](../glossary.md#capability-seam) exposing semantic code navigation on one `ctx.lsp` service, split across packages: Service Definition ([dsh-lsp](../../packages/lsp/lsp), `ctx.lsp` + the provider registry), a generic Service Provider ([dsh-lsp-stdio](../../packages/lsp/lsp-stdio), a configured stdio language-server host), and Consumer ([dsh-tool-lsp](../../packages/lsp/tool-lsp), the `lsp` tool schema). LSP is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks for navigation.

Source: [`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)

## Operations and coordinates

The seam and model expose exactly four semantic queries; the union is closed, so adding one is a compile-enforced change across the seam, providers, and the tool. Positions and ranges are zero-based UTF-16, matching the protocol; the model-facing tool owns the one-based cursor convention and converts on the way in and out.

```ts type-equiv
/**
 * The four semantic queries the seam and model expose. A closed union: adding an operation is a
 * compile-enforced change across the seam, providers, and the tool. Symbols and call hierarchy are
 * not operations here; they need different schemas.
 */
type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
```

```ts type-equiv
/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}
```

```ts type-equiv
/** A zero-based UTF-16 half-open range `[start, end)`. */
interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}
```

## Request

Every field is required: `workspaceRoot` is caller-supplied, `languageId` comes from the provider's registration (not the request), and consumers own timeouts and result limits — so no field needs implementation defaulting and there is no `resolve()` step. The provider receives the caller's request plus the derived `languageId`, which only synchronizes the transient document and never participates in selection.

```ts type-equiv
/**
 * A caller's normalized query. Every field is required: `workspaceRoot` is caller-supplied,
 * `languageId` comes from the provider registration (not here), and consumers own timeouts and
 * result limits — so no field needs implementation defaulting and there is no `resolve()` step.
 */
interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
}
```

```ts type-equiv
/**
 * A request as a provider receives it: the caller's {@link LspQueryRequest} plus the `languageId`
 * the seam derived from the provider's extension mapping. The language id only synchronizes the
 * transient document; it does not participate in selection.
 */
interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}
```

## Result

A CLOSED discriminated union: navigation operations normalize to `locations`, `hover` to content or `null`. Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled. `findReferences` always includes declarations — the provider enforces this internally, so callers get no flag. The `locations` variant carries `resolvedWorkspaceUri`, the provider's canonical workspace `file:` URI. A caller relativizing location URIs uses that coordinate rather than applying host-platform path rules to the possibly-symlinked request root.

```ts type-equiv
/** One resolved location: a document URI and the range within it. */
interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}
```

```ts type-equiv
/** Normalized hover content, or `null` for no hover at the position. */
interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}
```

```ts type-equiv
/**
 * The closed result union. Navigation operations (`goToDefinition`, `findReferences`,
 * `goToImplementation`) normalize to `locations`; `hover` normalizes to content or `null`.
 * Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled.
 *
 * The `locations` variant carries `resolvedWorkspaceUri`: the provider's canonical `file:` URI for
 * the request's workspace root. A caller that relativizes location URIs MUST use this, not parse the
 * request's possibly symlinked process path with host-platform rules; the execution platform may
 * differ from the caller's.
 */
type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }
```

## Provider and service

A provider owns a stable branded `id` and an exclusive lowercase leading-dot extension map. `registerProvider` reserves the id and every extension atomically — an invalid or conflicting registration publishes nothing — and its disposer releases all reservations. Selection is per query and order-independent; no match throws `LspError` `LSP_UNAVAILABLE`. The seam exposes no protocol types, process/document controls, or generic JSON-RPC escape hatch.

```ts type-equiv
/**
 * A language-server backend registered on `ctx.lsp`. Each provider owns a stable {@link
 * LspProviderId} and an extension-to-language-id map (lowercase, leading-dot keys).
 * `findReferences` always includes declarations — the provider enforces this internally; callers
 * get no flag.
 */
interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The seam has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query (caller request + derived language id).
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}
```

```ts type-equiv
/**
 * The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query
 * execution; exposes exactly the four operations and no protocol escape hatch.
 */
interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict
   * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
   * reservations. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's extension and run one query. Selection is per-query and
   * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}
```

`LspProviderId` is the seam's branded id (`Branded<'LspProviderId'>` from [dsh-brand](../../packages/util/brand)); `LspError` extends `HarnessError` with the stable codes listed under [Failures](#failures), which callers route on instead of parsing `message`.

<a id="failures"></a>
## Failures

Every expected failure of an `lsp` tool call is a `HarnessError` whose `name` and `code` the tool result keeps in `error.info`. `LspError` sets `name` to `LspError`; its `code` stays open because providers and consumers add codes, so consumers tolerate codes they do not know. Invalid tool arguments fail as `ToolArgsError` `INVALID_ARGS`, and caller cancellation as `AbortError`. Workspace and source reads keep the filesystem provider's `FsError` code, such as `FS_NOT_FOUND`, `FS_NOT_REGULAR_FILE`, or `FS_NOT_TEXT`, and prefix the LSP operand to its message; the stdio provider adds `FS_NOT_DIRECTORY` for a non-directory workspace and `FS_TOO_LARGE` for a source over `maxDocumentBytes`. A coded query failure whose server teardown also fails keeps the query failure's `name` and `code` and appends the teardown failure to its message; a query failure without a code, such as a cancellation, surfaces with the teardown failure as an `AggregateError` without `error.info`.

| Code | Raised by | Meaning | Consumer action |
|---|---|---|---|
| `LSP_INVALID_PROVIDER` | Seam | A registration has an empty id or language id, no extensions, or an invalid extension | Fix the registration |
| `LSP_CONFLICT` | Seam | The provider id or an extension is already registered | Remove the duplicate registration |
| `LSP_UNAVAILABLE` | Seam | No provider handles the file's extension | Query a supported file or add a provider |
| `LSP_WORKSPACE_REQUIRED` | `lsp` tool | The call has no Agent Session workspace | Call the tool from an Agent Session |
| `LSP_DISPOSED` | Provider | The provider or its server instance was disposed | Retry after the provider is mounted again |
| `LSP_UNSUPPORTED_OPERATION` | Provider | The server lacks the operation or transient open/close synchronization | Choose another operation or server |
| `LSP_MALFORMED_RESPONSE` | Provider | The server's `initialize` or query result violates the protocol | Report the server defect |
| `LSP_FILE_OUTSIDE_WORKSPACE` | Stdio provider | The source resolves outside the canonical workspace | Query a file inside the workspace |
| `LSP_UNSUPPORTED_ENCODING` | Stdio provider | The server negotiated a position encoding other than UTF-16 | Use a server that supports UTF-16 |
| `LSP_SPAWN_FAILED` | Stdio provider | The subprocess provider failed to launch or run the server; a provider `HarnessError` keeps its own `name` and `code` instead | Fix the server command or installation |
| `LSP_SERVER_EXITED` | Stdio provider | The server exited or closed its stdin; after an exit, the message carries the retained stderr tail | Retry later; inspect the stderr tail when it repeats |
| `LSP_PROTOCOL_ERROR` | Stdio provider | The server's output broke base-protocol framing or JSON | Report the server defect |
| `LSP_MESSAGE_TOO_LARGE` | Stdio provider | A server message exceeded `maxMessageBytes` | Narrow the query or raise `maxMessageBytes` |
| `LSP_SERVER_ERROR` | Stdio provider | The server answered with a JSON-RPC error; the message carries its numeric code and text | Act on the server's message |

After a transport failure (`LSP_SPAWN_FAILED`, `LSP_SERVER_EXITED`, `LSP_PROTOCOL_ERROR`, or `LSP_MESSAGE_TOO_LARGE`), the stdio provider retries the read-only query once on a fresh process when the failed process tears down cleanly.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlsp--lspservice"></a>

### `ctx.lsp` — `LspService`

The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query execution; exposes exactly the four operations and no protocol escape hatch.

```ts cordis-catalog
/**
 * Register a provider, atomically reserving its id and every normalized extension. Any conflict
 * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
 * reservations. Disposed with the calling fiber.
 * @param provider - the backend to register.
 * @returns a synchronous disposer releasing the id and all extension reservations.
 */
registerProvider(provider: LspProvider): () => void

/**
 * Select a provider by the file's extension and run one query. Selection is per-query and
 * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
 * @param request - the normalized query.
 * @param signal - optional cancellation forwarded to the selected provider.
 * @returns the normalized, closed-union result.
 */
query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
```

Source: [`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)
<!-- END GENERATED cordis-surface -->
