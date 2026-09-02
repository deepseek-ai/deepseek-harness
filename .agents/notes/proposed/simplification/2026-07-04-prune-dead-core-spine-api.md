# Agent Note: Prune dead public API and result fields

Status: proposed

English | [中文](2026-07-04-prune-dead-core-spine-api.zh.md)

## Problem

Several package-root exports, result fields, and convenience methods have no production consumer. They survive because tests import internals through public entry points or because a type anticipated a caller that never arrived. Each item is small in isolation, but together they enlarge the SDK contract, generated catalogs, documentation, and regression matrix without enabling a shipped path.

The production corpus is `packages/*/*/src`, example sources/config, and runtime scripts. Tests, package READMEs, and Agent Note prose are evidence of publication but not fixed callers. `cordis_inspect` makes `packages/extensions/tool-cordis/src/api-catalog.ts` model-visible, and `cordis_mount` can invoke injected services through guarded real-service proxies, so catalogued service methods and returned shapes are a genuine dynamic product surface. The table therefore distinguishes absence of a fixed repository caller from unreachability: rows touching catalogued vocabulary intentionally contract what model-written mounts can discover and call, while package-root implementation helpers are not reached through that service façade. Exact-symbol searches produce the following inventory:

| API element | Production evidence | Simplification |
| --- | --- | --- |
| `SurfaceManager.invalidate()` | Only its unit test calls it; seeding completes before the lazily-created manager exists and the session never replaces its log reference. | Delete it and its impossible wholesale-replacement contract. |
| `ToolExecutionResult.callId` | Every hook already receives the immutable `ToolExecution`; the loop and ACP correlate through the call/session event. No consumer reads the duplicate result field. | Remove the field, copy/mismatch guards, and tests that prove the duplicate cannot disagree. |
| `ReactLoopAgent` root export | Outside-package named imports are tests; production programs against `Agent` and creates/resumes through `ctx.agents`. | Return/interface-type `Agent` and make the concrete loop class package-internal; keep the deliberate synchronous config-only `AgentLoop.create()` path. |
| `workflow-worker-thread` protocol/runtime/session re-exports and named `WorkerThreadWorkflowEngine` | Every package-name consumer uses the default engine; the workflow Agent Note already defines the worker wire protocol as private. | Keep the default plugin class/config contract; drop the duplicate named class export and keep protocol modules source-private. |
| `code-runtime-worker` protocol/bootstrap re-exports | Outside-package production/e2e consumers use `WorkerThreadCodeRuntime` and config, not `BootstrapPort`, `PatchableStream`, or worker message/boot types. | Keep the runtime class/config contract and make its wire/bootstrap vocabulary source-private. |
| ACP `agentOptions` root export | The helper has only same-file and ACP-test consumers; the sole outside-package production consumer mounts the plugin namespace. | Keep `name`, `inject`, `Config`, `AcpConfig`, and `apply`; make `agentOptions` source-private and test it through bridge behavior. |
| `providerWording` and `completedTurnPrefix` root exports | Each has one same-package production caller; only the balanced-prefix helper has a same-package white-box test. | Make them source-private and test provider behavior. |
| `depthOf`, `SubagentDepthError`, `waitForExit`, and `exitsWithin` root exports | Production subagent backends consume the in-process runner and subprocess construction/disposal helpers, not these enforcement/test internals. `SENSITIVE_ENV_PATTERN` is excluded because the SDK helper applies it to caller-supplied environments. | Keep depth and exit behavior but make the remaining helpers and error source-private; test through spawn and disposal. Keep the shared credential pattern public. |
| `LlmError.status` and replay status | Adapters/replay populate it, but production branches on stable error code/message and never reads raw status. | Remove the unread field and replay plumbing while preserving error classification. |
| `BlockAssembler.push()` return value | Both production callers ignore the returned completed block. | Return `void`; keep the deliberately public `blocks()`/`message()` contract. |
| `compactRegion`'s separate `session` argument | The fixed caller passes the same object already present as `agent.session`; the model-visible mount API can also call the method, but accepting two identities permits a mounted plugin to provide an incoherent pair. | Keep the manual-region API while deliberately narrowing it to `agent.session` as the one source of truth. |
| `CompactionResult.startSeq`, `summarySeq`, `endSeq`, and `summary` | The production consumer reads only shadowed range/seq/token accounting; the durable log owns summary and event identity. | Remove the four result echoes while keeping both shared transcript renderers. |
| `BasicCompactionEngine` estimation/summarization visibility | No outside production caller invokes the five methods; the implemented Agent Note names only `estimateContentTokens()` and `summarize()` as subclass hooks. | Make those two `protected` and the three orchestration-only estimators private. |
| `CodeLogEntry.source`/`level` and `RunCodeMeta.dispatches` | Every production consumer maps logs to text; no presenter/model path reads the other fields or the persisted dispatch count. | Make code-runtime logs strings (or text-only entries) and remove result-meta dispatch plumbing; keep the local counter that mints deterministic dispatch ids. |
| `CodeRuntime.language` and `CodeRuntime.isolation` | The worker backend supplies the only production values, while PTC mode and every other production caller invoke only `run()`. | Remove the unread descriptors while preserving the worker's language, isolation, budgets, cancellation, and disposal behavior. |
| `ToolNotFoundError.toolName`, `SystemPrompt.config`, and `BashTask.command` | Each stored public value has no production reader. | Drop the unread field while retaining error messages, resolved configuration behavior, and task lifecycle. |
| Backend package-root implementation helpers | The exact inventory below is called only through relative same-package imports. Production namespace imports mount the retained plugin contract without reading these properties; named root consumers are tests. | Retain each adapter/provider/service and its config/error contract; stop exporting the listed helper functions/constants at package roots. |
| Consumer package-root implementation helpers | The exact inventory below has only same-package production callers. Production namespace imports mount plugin contracts without reading helper properties; named root consumers are tests. | Retain plugin contracts and stable error codes; move tests to package-local modules or public behavior and stop exporting the listed helpers at package roots. |

### Grouped helper-export inventory

- `dsh-llm-deepseek`: `httpErrorCode`, `serializeMessages`, `serializeRequest`, `DONE`, `parseSse`, `mapFinishReason`, `mapUsage`, and `translate`; `dsh-llm-pi-ai`: `buildModel`, `mapStopReason`, `mapUsage`, `toPiContext`, and `toStreamChunks`.
- `dsh-bash-local`: `DEFAULT_GRACE_MS`, `ENV_OVERRIDES`, `killGroup`, `OutputCollector`, and `runBash`; `dsh-bash-sandbox`: `shellQuote`, `classifyDenial`, and `classifyRunnerFailure`; `dsh-sandbox-local`: `bwrapProfileArgs`, `landlockProfileArgs`, and `seatbeltProfileArgs`. The public mutable test-injection fields and their types are outside this proposal.
- `dsh-fs-local`: `applyLiteralEdit`, `listDirectory`, `probe`, `readForEdit`, `readTextForDiff`, `readWholeText`, `resolveLocalTarget`, `restoreLineEndings`, `streamWholeText`, and `writeFileAtomic`.
- `dsh-web-fetch-http`: `classifyContentType`, `decoderForCharset`, `isSameOrigin`, `parseCharset`, and `validateFetchUrl`; `dsh-web-search-exa`: `mapExaResponse` and `mapExaResult`; `dsh-web-search-deepseek`: `citationSnippets` and `mapAnthropicResponse`; `dsh-web-search-perplexity`: `mapPerplexityResponse` and `mapPerplexityResult`.
- `dsh-tool-fs`: `READ_LIMIT`, `STREAM_MIN_SIZE`, `READ_MAX_BYTES`, `READ_MAX_LINE_LENGTH`, `DIFF_CONTEXT`, `applyReadTool`, `parseReadArgs`, `applyWriteTool`, `formatWriteOutput`, `parseWriteArgs`, `applyEditTool`, `formatEditOutput`, `parseEditArgs`, `buildWindow`, `formatReadOutput`, `computeHunkDiffs`, and `diffsFromMeta`.
- `dsh-tool-web`: `WEB_SEARCH_MAX_RESULTS`, `applyWebSearchTool`, `formatSearchOutput`, `parseSearchArgs`, `presentSearchCall`, `applyWebFetchTool`, `formatFetchOutput`, `parseFetchArgs`, `presentFetchCall`, `renderBody`, and `htmlToMarkdown`; `dsh-tool-call-timeout-policy`: `toolTimeoutResult`; `dsh-compaction-basic`: `resolveConfig`; `dsh-tool-bash`: `renderResult`.

## Proposal

Remove or demote every row as one bounded coordinated public-surface cleanup. Update package READMEs, JSDoc, generated API/event catalogs, type-equivalence records, exports maps where needed, and tests so they exercise the owning public contract instead of preserving test-only entry points. Do not collapse any capability seam, LLM adapter, persistence provider, or lifecycle quiescence contract.

## Alternatives considered

**Keep test conveniences and self-contained results public.** Public helpers can make white-box tests convenient, self-contained result fields can look ergonomic, and future embedders might want the concrete loop or enumeration methods. Those benefits are hypothetical; retaining them makes every implementation and document explain states that no shipped caller can observe. A real consumer can introduce the smallest contract it needs, with its ownership and failure semantics known.

**Keep every catalogued member for model-written mounts.** The self-referential toolset is a real generic consumer route, not generated-doc noise. Its value comes from an accurate, composable service API, however, not from preserving duplicate fields or incoherent argument pairs indefinitely; each catalogued contraction above removes a fact available elsewhere on the same execution, agent, or result and updates the API reference in the same change.

## Acceptance criteria

- Exact-symbol searches show no removed API outside this Agent Note and any implemented-Agent Note amendments.
- Every API element listed in this Agent Note is absent or demoted as specified; deliberately retained extension/test contracts outside the inventory are unchanged.
- Tool execution, compaction, both LLM adapters, the persistence provider, workflow isolation, and agent creation/resume retain their shipped behavior.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

Most removals are compile-visible but runtime-neutral. The compaction argument cleanup deliberately forbids a session/context mismatch while retaining the manual-region API. External pre-release embedders and existing model-written mounts may import fewer helpers, pass fewer arguments, or receive narrower result shapes; this is an intentional product-surface contraction, not merely generated-catalog cleanup. The repository is unreleased, so carrying unsupported surface is the larger foundation cost.
