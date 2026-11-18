# Agent Note: Active tool headers and stateful request projection

Status: implemented

English | [中文](2026-09-20-dynamic-tool-updates.zh.md)

## Problem

Plugin and MCP tools change during conversations. Providers differ in whether they activate deferred definitions or remove tools through history. Storing retained provider declarations as active tools makes comparisons repeat removals and miss restorations.

## Decision

`request/header.tools` records assembled active tools independently of model capability. The loop compares names against the preceding header and emits one `developer/message` with additions and removals under the `tool-registry` source. Additions reference the new header through `headerSeq`. Definition changes remain header changes; unchanged names emit no update. Existing header equality and request-series rules remain in force.

`Session.toolHistory()` caches a capability-independent fold of committed headers and developer messages. First access restores inherited events; later reads consume only unseen events. Immutable snapshots carry initial declarations and ordered update identities with additions resolved through their historical headers. Explicit series starts and changed retained definitions rebuild declarations. Restoring a retained name with an unchanged definition continues the series: the projection keeps the declaration unchanged and lets the recorded addition re-offer the tool after its earlier removal, so a removal never disables a declared tool and a loading mode never rewrites an earlier declaration.

Loop and compaction requests carry this snapshot as `GenerateOptions.toolHistory`. At adapter dispatch, `projectToolUpdates` uses the prepared route's `toolUpdate`. Unsupported routes receive active definitions without `deferLoading` or developer messages. Supported routes defer historical additions; `in-history` retains removed definitions and removal blocks, while `addition-only` omits both. On addition-only routes, removing any tool rebuilds the route's baseline after that update: the request declarations change even when the removed tool was activated later, so retaining superseded activation blocks cannot preserve the full conversation prefix. Adding tools when no declarations exist also rebuilds the baseline. Deferred declarations count as existing tools. The first native tool changes the empty declaration prefix; deferring it provides no cache advantage over declaring it immediately. Previously activated tools become immediate; explicitly deferred declarations with no activation remain deferred. Subsequent additions remain deferred until their recorded activation. Superseded tool blocks are omitted without discarding other content in those messages. The Session fold and durable events remain capability-independent. Missing history or a request prefix omitting recorded updates uses current declarations without developer updates.

DeepSeek translates projected updates into system-role `tool_addition` and `tool_removal` blocks and `defer_loading` declarations, sending the tool-changes beta header when update blocks occur. The default `deepseek-flash` entry declares `addition-only`; pi-ai selects `in-history` for compatible Anthropic routes and `addition-only` for compatible Chat Completions and Responses routes. Chat and Trajectory display developer messages as context nodes, using localized tool-change notices: single changes show the tool name; multiple changes show counts and expandable name lists.

## Alternatives considered

**Store provider declarations in headers.** Retained removed definitions are not active tools. Mixing those meanings makes durable updates capability-dependent and breaks change detection.

**Reconstruct definitions in adapters from messages alone.** Addition messages contain names, not schemas or event-level header references. Session owns that historical relationship; adapters translate projected requests.

**Scan the complete log on every request.** The cached fold consumes new events and supplies stable snapshots to ordinary and auxiliary calls without adding arbitrary synchronous history readers.

**Rebuild the baseline on every removal.** Deferred tools also have request declarations; deleting a tool changes those declarations regardless of its activation position. Addition-only routes cannot express that deletion in history. The rebuild therefore also covers removal-only updates and removals of later-activated tools. A past reset cannot force every future addition to become immediate: each reset establishes a new baseline from which deferred additions resume.

**Reject same-name schema changes during tool registration.** This restriction is not enforced. Immediate failure for a plugin registering an incompatible tool requires comparing the new registration with historical definitions of tools called on each affected current surface, while excluding calls removed by compaction. That registration-time historical and scope-aware check is deferred because of its implementation complexity. Same-name schema changes remain allowed; they rebuild declarations and invalidate prefix reuse even on `in-history` routes.

## Consequences

Tool lists and logical update events are capability-independent; only outgoing declarations and messages vary. Calls to removed retained tools fail through the existing `UNKNOWN_TOOL` path. Changed definitions and incomplete auxiliary prefixes sacrifice prefix reuse for coherent declarations; unchanged restoration keeps the cached prefix on `in-history` routes only while the request series continues. Routes supporting tool updates and in-history system prompts preserve earlier messages when tools are added alongside a changed prompt or after an earlier prompt update. Routes without tool-update support still start a new series on tool changes; explicit series starts and surface replacements consolidate the prompt only when the effective text differs, and otherwise leave the surviving prompt node in place. No persisted fields or Session format revision are added.

The authored [headless prompt/tool scenario](../../../../snapshots/session/dynamic-tool-prompt-updates/snapshot.yml) pins an appended prompt beside a deferred tool addition and verifies that the first request's messages stay unchanged. It shares the stable-prompt scenario's tool lifecycle and schema expectations.

The [DeepSeek replacement scenario](../../../../snapshots/session/deepseek-deferred-tools/snapshot.yml) checks the first additions to an empty set, a rebuilt baseline, a subsequent deferred addition, and removal of that later-activated tool through Messages serialization. Explicit deferred-only requests remain unchanged under the [DeepSeek failure policy](../simplification/2026-11-02-deepseek-deferred-tool-failures.md). These checks establish request construction, not measured cache savings from rebuilding.

The [real DeepSeek SDK test](../../../../apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts) measures the first request after a native tool addition with both unchanged and simultaneously updated instructions. Unique user history prevents a shared system-prompt cache hit from satisfying the preceding-input assertion. Removal checks tool availability without requiring cache retention; each case disables retries.
