# Agent Note: Tighten the hook-protocol contract — dialect, discarded fields, double defaults, and lib-owned `hook/result` semantics

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-04-tighten-hook-protocol-contract.zh.md)

## Problem

Four pieces of the `dsh-hook-protocol`/bridge contract missed the discipline the [subagent-observe-enrich Agent Note](../../archived/feature/2026-06-30-subagent-observe-enrich.md) records — it dropped an `agentType` lifecycle field for lacking a consumer, and these failed the same test:

1. **`HookDialect`'s `'native'` variant** (`packages/hooks/hook-protocol/src/types.ts`) had zero producers — the bridges stamp `'claude'` and `'codex'`; the only `'native'` constructor anywhere was the lib's own unit test. The field's own JSDoc defines `dialect` as "the bridge that ran it", and native is not a bridge: the [interception extension-points Agent Note](../feature/2026-06-30-interception-extension-points.md) records that native hooks are not a package and that "a native plugin can already use the typed Decisions" without the durable hook log, and the flagship native-plugin worked example asserts exactly that (no `hook/*` events at all).
2. **`HookOutput.suppressOutput`** (same file) was parsed by the codec and discarded on every path: no bridge branch, no merge fold, no warn, no deferred-list row — uniquely among its parsed-but-unhonored siblings, each of which carries a stated deferral (`updatedInput` → a logged warn plus the [pre-tool-input-rewrite proposal](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md); `systemMessage` → a logged warn plus a README deferred row; `continue`/`stopReason` → a `TODO(hook-continue-false)` anchor plus the `'stop'` decision record). Structurally there is nothing to suppress: hook stdout never enters any transcript (context flows only via `additionalContext`; the log records only `decision`/`stderrSummary`), so a hook author setting `suppressOutput: true` got silent nothing with no warn.
3. **`defaultTimeoutMs` was double-defaulted in both bridge configs with a floating literal** — a schema `.default(600_000)` AND a `?? 600_000` fallback (`packages/hooks/hooks-claude-code/src/index.ts`, `packages/hooks/hooks-codex/src/index.ts`), two homes per bridge for one protocol-level constant, so the bridges could silently drift apart on the shared default. *The knob stays as explicit bridge-owned config per the no-hardcoded-tunables rule (with `stderrSummaryMaxChars` beside it); the fix is the literal's home.*
4. **The `hook/result` semantics lived in the bridges, twice, not in the lib that owns the event.** `summarize()` — the stderr truncation rule — was byte-identical in `packages/hooks/hooks-claude-code/src/index.ts` and `packages/hooks/hooks-codex/src/index.ts`, and so was the decision-string rule `output.decision ?? (output.continue === false ? 'stop' : 'pass')`; yet `dsh-hook-protocol` declared `hook/result`, documented `stderrSummary` as "truncated" without owning the truncation, and documented the decision values without owning the mapping. If one bridge drifted (a different cap, a different fallback), the shared durable event's semantics would fork silently.

## Decision

`HookDialect` is the closed bridge set, `'claude' | 'codex'`; `HookOutput` omits unsupported `suppressOutput`. `hook/result.durationMs` remains durable audit timing and is normalized only in snapshots. Reference defaults live once in `DEFAULT_HOOK_TIMEOUT_MS` and `DEFAULT_STDERR_SUMMARY_MAX_CHARS`. `HookResultRecord` and `appendHookResult` own stderr summarization and decision derivation for both bridges. `BLOCKING_EXIT_CODE` is codec-internal.

## Alternatives considered

### Why not keep them?

Unsupported vocabulary can return when a real consumer exists. `durationMs` remains because durable audit timing is useful independently of a current reader. Bridge-specific payload construction stays in each bridge, while shared durable-event normalization belongs in the protocol library.

## Verification

`HookDialect` contains only Claude and Codex, and `suppressOutput` is absent from source, parsed-field docs, and normalization. `durationMs` remains in events and fixtures with replay scrubbing. The `600_000` and `500` defaults each live once in the protocol library, per-hook timeout overrides still apply, and both bridge suites exercise the library-owned stderr truncation and decision rules.

## Consequences

The `dialect`, `suppressOutput`, tunables, and semantics changes are invisible on the wire and in the expected outputs. The cost was churn in `dsh-hook-protocol` and both bridges — cheap under the pre-release stance, and cheaper than letting two copies of a durable event's semantics age apart.
