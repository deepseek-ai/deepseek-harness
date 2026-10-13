# Agent Note: Unified Typert/Remote metadata

Status: proposed

English | [中文](2026-09-20-unified-typert-remote-metadata.zh.md)

## Problem

CLI help, argument parsing, and MCP tool discovery need local method descriptions, named-input parsers, tool JSON Schemas, and result metadata before connecting to a controlled Host. Browser, Node, and independent consumers also need typed invocations. Tool consumers need stricter input-object validation without changing ordinary Host dispatch. These requirements do not imply runtime TypeScript analysis, Host Service activation, or another business schema maintained by each consumer.

The original #4644 source-definition decision delivered this information through `emitSourceDef`, committed generated files, and `./remote-source`. Host bindings carried those definitions; source generation had its own inventory, freshness, publication, and exclusion rules. This note replaces that delivery mechanism and makes input strictness consumer-owned.

Both delivery paths derive from the same [compiler-independent model](../../implemented/architecture/2026-07-27-compiler-independent-typert-model.md). Separate Host and Client Programs require generated cross-face declarations, not committed generated source. An explicit prebuild is acceptable when exact schemas are needed; ordinary ESM artifacts can supply offline metadata without a live Host. The [targeted-call decision](../../implemented/architecture/2026-08-02-typert-remote-method-calls.md) still owns receiver lookup, Gateway dispatch, and contribution lifetimes.

## Technical architecture

| Export | Responsibility | Registration |
|---|---|---|
| Host `./typert` | `TYPERT`: local reflection, schemas, and an `invocations` getter exposing a private info instance's descriptors. | Loader imports and validates the contribution, then calls `ctx.typert.register(TYPERT)`. |
| Host-for-consumer `./remote` | Default export and `TYPERT_REMOTE`: a `TypertRemoteInfo` with descriptors and typed `methods`, plus generated Remote declarations/maps. | Harness metadata consumers call `ctx.typert.remotes.register(TYPERT_REMOTE)`; live consumers use `ctx.remote.$mount(TYPERT_REMOTE)`, which already registers it. Independent readers need no Registry. |
| Client `./client/typert` | The Client face's own local reflection and schemas. | Its local Registry; this is not the Host Remote projection. |

[Registry](../../../../packages/typert/registry/src/service.ts) instances belong to their Cordis Context and process. Host and Client entries share implementation, not state. Existing local/Remote `get()` and `list()` preserve the registered descriptor objects; registration retains atomic duplicate checks, notifications, tombstones, and fiber-owned disposal. No Registry API, store, subscription, metadata RPC, or cross-process synchronization is added. Separate Programs and processes do not share object identity.

The [emitter](../../../../packages/typert/generator/src/emitter.ts) writes one static `TypertRemoteMethodSpec` per endpoint and calls `createTypertRemoteInfo({ package, methods }, z)` from the published pure `@deepseek-ai/dsh-typert-protocol/remote-info` entry. The endpoint key supplies `namespace` and `method`, and `id` combines it with the package. Each spec keeps the service, receiver, ordered parameters, single `result` codec, and optional stream, scope, uplink, cancellation, documentation, and source-location fields. Every parameter has both `codec` and `strictCodec` from the same checker-resolved type model, with no per-method policy in the analyzer or model. Parameter `wire` defaults to `name`; parameter documentation stays on `parameters[].description`. There is no nested `metadata`, separate `output` or `parameterDescriptions`, or top-level `REMOTE_METHODS` export.

The [factory](../../../../packages/typert/protocol/src/remote-info.ts) returns an actual class instance, not a class constructor or eager object literal. Construction retains only the spec and the Zod runtime explicitly supplied by the generated artifact, without constructing schemas. The first `descriptors` or `methods` read, including mounting or querying, builds and caches one shared index. Each `methods[endpoint]` aliases the exact direct descriptor object; Context-only receivers remain in descriptors and scoped declarations. Direct methods with scoped projections retain their scope fields but their generic named invoker requires an unscoped Remote.

A direct method's `input(options?: TypertRemoteInputOptions)` returns a cached `TypertRemoteValue<Input>`; `strict?: boolean` is the only option. `method.input()` and `{ strict: false }` use normal codecs: declared objects accept and strip unknown fields. `{ strict: true }` rejects undeclared fields recursively. Both named-argument envelopes reject extra arguments; explicit JSON and dictionary keys stay open, and constrained dictionary values still validate. Consumers select one view for matching `input.create().parse(raw)` and `input.jsonSchema`. Host dispatch and the single `result` codec retain normal behavior, including binary `encode`/`decode`.

Each input-policy view, its named parser, and its JSON Schema projection are independently lazy and cached. Individual generated Zod factories are also lazy and success-cached. The raw spec requires Zod factories internally, while consumer-facing `TypertSchema<T>` promises only `parse(value: unknown): T`. JSON Schema remains an optional generator projection, not runtime `z.toJSONSchema()` conversion. Generated artifacts import and supply Zod, including Remote endpoints without parameters or exported schemas. The pure leaf retains only Zod type imports and has no runtime module dependencies; the protocol root re-exports the factory and imports Cordis without adding Zod to every protocol consumer's static module graph. Imports and metadata/schema access never invoke the network.

Registry queries return base descriptors. `isTypertRemoteMethod(descriptor)` from the pure leaf or protocol root narrows direct capabilities with `object`/`unknown` types; exact endpoint types come from `TYPERT_REMOTE.methods`, not dynamic lookup. Unary `mode` is omitted; streaming `mode` is `'stream'`. `invoke(remote, input, signal?)` resolves the mounted namespace method at call time, preserving its `this`, optional positional holes, and signal. It forwards the same full `Promise<RemoteResult<DecodedOutput>>` or `RemoteStreamHandle<Output, Uplink>` without an async wrapper; stream iteration, `send`, `end`, and `dispose` remain available. The fifth `TypertRemoteMethod` generic retains the carrier-decoded unary byte type independently of the result parser's authored output.

Documentation and JSON Schema are optional. Each unsupported input variant or result projection records its own `jsonSchemaError` while preserving parsers and independent documentation; only the dedicated projection error is caught. A consumer explicitly selecting a tool requires its description and supported input JSON Schema. Output parsing remains required even when optional output JSON Schema is absent. Native `dsh-tools` registration additionally requires `output.schema`: a parser alone does not satisfy it. These consumer requirements must not prevent an otherwise valid Remote method from being generated.

## Proposal

Complete the ordinary-artifact migration in the downstream Session-client, CLI, MCP, and native-tool packages. This note remains proposed because that migration is not complete.

### Shared generation, two access modes

Framework consumers load ordinary metadata into their own Registry. Independent consumers may import `./remote` directly without Cordis, Host Service activation, or a connection. Both read the same generated business definition. Keep separate Host/Client Programs and analyze all contributors of each face so focused emission retains external declaration augmentations. Registration does not expose every reflected method as a callable endpoint or tool.

Strict source startup explicitly prebuilds and loads ordinary `./typert` through Loader. Limited descriptor-free fallback still supports basic arguments, signals, cancellation, streams, JSON conversion, and unary byte attachments, but cannot recover erased fields, constraints, or tool documentation. Once a strict local descriptor has been observed, its withdrawal must refuse invocation rather than downgrade to fallback. `@Remote` accepts only `name` and `mode`; consumers choose input policy without a separate developer annotation.

Host metadata readiness remains composition-owned. A Host requiring strict validation must await local registration before serving calls; `hasSeen()` does not protect an endpoint before its first registration. Returning a lazy info instance neither completes asynchronous Loader discovery nor establishes readiness. Loader validates static codec specs and callable `input`/`invoke` without calling the selector, parser factories, or projections to register a contribution.

### Downstream migration targets

The inspected #4111 tree contains Session-client, CLI, MCP, and native-tool consumers that are not present as complete packages on this branch. Its Session client selects 13 Session methods plus Workspace listing from source exports. Migrating that tree requires updating selection, connection-time mounts, offline CLI initialization, MCP presentation, and native-tool registration together; deleting source exports alone is insufficient.

| Consumer | Metadata adaptation | Execution retained |
|---|---|---|
| Browser / Node Remote callers | Import ordinary `./remote`; mount once in the live Context. | Generated namespaces, Gateway, authenticated Connection, and target controllers. |
| Offline CLI help / parsing | Register before target discovery in the CLI profile's metadata Context; select `input({ strict: true })`. | No connection for help; a separate live Context mounts when calling. |
| MCP discovery / calls | Read selected Registry entries with `input({ strict: true })`; retain consumer-owned tool descriptions and envelopes. | `tools/list` is offline; `tools/call` uses the same Session client. External MCP clients receive protocol JSON, not Registry modules. |
| Native tools | Read Host local method info; require the tool registration's `output.schema`. | Parse at the tool boundary, then call same-process controllers directly. |
| Independent adapters | Read typed `TYPERT_REMOTE.methods` directly. | Use their chosen Remote runtime only when invoking. |

Current-session selection and attachment preparation remain consumer-owned; CLI/MCP intake validates completed business arguments with the same strict input view used during selection. The downstream `follow` adapter's `activate: false` policy applies where that API exists; this branch's current `follow` has no such option. Aborting observation does not cancel accepted Session work.

### Paired usage examples

The old examples are historical comparisons of source-export consumers in the dependent changes. The new examples use ordinary artifacts. These fragments omit surrounding plugin declarations and include removed APIs. `raw`, `request`, `signal`, and an authenticated, mounted, unscoped `remote` are caller inputs, not new framework APIs.

**Operation owner and strict Host.** Preserve the business signature; leave generated registration to ordinary Typert Loader instead of the Service constructor.

```text
// Old source delivery.
import { TYPERT_REMOTE } from './remote.generated.ts'
// Constructor: super(ctx, 'sessionController', { namespace: 'session', definitions: TYPERT_REMOTE })
@Remote({ name: 'page', emitSourceDef: true, rejectUnknownFields: true })
page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
  return this.history.page(request, signal)
}

// Ordinary delivery; no generated-source import or constructor definitions.
// Constructor: super(ctx, 'sessionController', { namespace: 'session' })
@Remote({ name: 'page' })
page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
  return this.history.page(request, signal)
}
```

**Browser and Node invocation.** A source-export consumer changes `/remote-source` to `/remote`; existing ordinary consumers already use this path. The live Context mounts once, without separate Registry registration.

```text
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
await ctx.remote.$mount(TYPERT_REMOTE)
const result = await ctx.remote.session.page(request, signal)
const stream = ctx.remote.session.follow(followRequest, signal)
try {
  for await (const frame of stream) consume(frame)
} finally {
  await stream.dispose()
}
```

**Offline CLI and framework metadata.** The old selection reads a source table; the replacement reads the profile-owned Registry before target discovery. The two snippets are alternatives, not simultaneous declarations.

```text
// Old selection.
import { REMOTE_METHODS } from '@deepseek-ai/dsh-api-session-controller/remote-source'
const page = REMOTE_METHODS['session/page']
```

```text
// Metadata plugin: inject: ['typert']; no Gateway, Connection, or Host controller.
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
import { isTypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol/remote-info'
ctx.typert.remotes.register(TYPERT_REMOTE)
const page = ctx.typert.remotes.get('session/page')
if (page === undefined || !isTypertRemoteMethod(page)) {
  throw new Error('session/page generated direct method is not loaded')
}
```

The registration belongs to that plugin's fiber. Help uses `description` and `input({ strict: true })`; the typed facade can retain type-only imports from ordinary generated declarations. Explicit tool selection does not mutate registered metadata.

**CLI input and dispatch.** After local `current` resolution and attachment preparation, either metadata access path uses the same invocation sequence:

```text
if (page.mode === 'stream') throw new Error('session/page must be unary')
const input = page.input({ strict: true })
const arguments_ = input.create().parse(raw)
const result = await page.invoke(remote, arguments_, signal)
if (!result.ok) throw result.error
const output = page.result.create().parse(result.value)
```

**MCP discovery and calls.** Selection validates tool-specific requirements; generation itself does not require them.

```text
const input = page.input({ strict: true })
if (!page.description) throw new Error('session/page has no tool description')
if (input.jsonSchema === undefined) throw new Error('session/page has no supported tool input schema')
const tool = {
  name: 'remote_session_page',
  description: page.description,
  inputSchema: input.jsonSchema,
  ...(page.result.jsonSchema === undefined ? {} : { outputSchema: page.result.jsonSchema }),
}
```

This compact object shows only the metadata dependency. The real MCP adapter retains its `{ arguments, current, content }` input and `{ ok, value }` / failure output envelopes. Listing requires no connection; calling performs intake, local preparation, parsing through `input.create()`, invocation, and output parsing. Optional output projection does not remove output validation.

**Native tools.** Query `ctx.typert.local.get('session/page')` and narrow it with `isTypertRemoteMethod` instead of reading the source table. Native tools can select `method.input({ strict: true })` for matching parsing and input projection. Native registration still requires supported input and result projections, including core Tool's mandatory `output.schema`; optional MCP output projection is not sufficient here. Once the facade obtains a typed request, both designs execute the same local call:

```text
const value = await ctx.sessionController.page(request, signal)
```

**Independent consumers.** Read the ordinary info instance's typed index; no Registry is required:

```text
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
const page = TYPERT_REMOTE.methods['session/page']
const arguments_ = page.input().create().parse(raw)
const result = await page.invoke(remote, arguments_, signal)
```

**Strict source startup.** Build ordinary artifacts, then use the supported source launcher:

```sh
pnpm run build
pnpm dsh --profile <profile-name> <profile-arguments>
```

## Alternatives considered

- **Committed source:** meets offline needs but adds a redundant delivery and maintenance path; explicit ordinary prebuild is sufficient.
- **Nested descriptor metadata and a separate method table:** duplicate result and parameter facts and add another identity to track. One spec derives direct helpers on the descriptor itself; `TypertRemoteInfo` extends the existing contribution and retains `descriptors` so Gateway and Registry keep their current registration APIs.
- **Mandatory Registry for every importer:** adds lifecycle requirements without information for standalone consumers.
- **Fallback only:** cannot supply erased validation or tool documentation; retain it only for its supported subset.
- **Handwritten adapter schemas or runtime TypeScript analysis:** duplicate ownership or introduce runtime compiler requirements already handled by build-time extraction.

## Acceptance criteria

- Ordinary artifacts emit one static method spec per endpoint and return lazy class instances; direct method indexes alias descriptor objects, with full stream/binary typing, separate compiler faces, and full-face augmentation retention.
- Descriptor indexes and each input-policy view, parser, and projection are independently lazy and cached; Loader validates static specs and callable helpers without calling selectors, parsers, or projections.
- Every input parameter emits normal and strict codecs from the same model; consumers select policy without a method annotation. Both envelopes reject extra named arguments; strict input recursively closes declared objects without closing JSON or dictionary keys or changing Host dispatch and results.
- Protocol source and built entries have no Zod runtime dependency; generated artifacts explicitly supply Zod, zero-argument endpoints create empty inputs that reject extra fields, and the [production headless-profile Loader regression](<../../../../packages/context/time-context/tests/time-context.e2e.ts>) asserts actual Session events.
- Registry identity, atomic registration, withdrawal, and disposal remain intact.
- Missing documentation or unsupported optional projection does not disable generation; selected tools reject missing requirements and still parse outputs.
- Strict source/artifact invocation and limited fallback have separate tests; a withdrawn strict descriptor never enables fallback.
- Source static checks do not consume stale generated declarations; artifact checks declare and rebuild their inputs. No source-definition opt-in, source export, inventory, or freshness rule remains in production.

## Risks

Full downstream profile composition remains follow-up work in those packages; the generated metadata is not evidence that every #4111 operation or CLI/MCP application has migrated. The deliberate trade-off is an explicit prebuild for full source-runtime metadata. Missing or stale artifacts require regeneration, not a validation downgrade or a second handwritten schema.
