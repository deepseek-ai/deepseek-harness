# Agent Note: Unambiguous tool argument compatibility

Status: implemented

English | [中文](2026-09-20-unambiguous-tool-arguments.zh.md)

## Problem

Models can populate optional fields that do not affect the requested operation. Rejecting these calls adds retries without protecting any state.

## Decision

`grep` treats an exact empty `include` as omitted. Whitespace-only, negated, and comma-separated filters remain invalid. `update_goal` uses replacement fields only for `edit` and a blocker reason only for `blocked`; other actions ignore those known fields. Declared types, consumed values, authority, and exact revisions remain validated. Ignored fields never reach another goal operation or change unrelated state, and call summaries select only values used by the action. `write` and `edit` allow absent or blank justification when no sandbox mode is requested or the effective mode is repeated; actual widening retains its reason and approval requirements, and filesystem observation and denial checks remain active.

This partially supersedes the unused-field rejection in the [goal-tool decision](../feature/2026-07-19-model-facing-goal-tools.md). Its authority, lifecycle, scheduling, and persistence decisions remain active. The rules apply to every provider and stay inside the owning tool rather than weakening its underlying service.

## Alternatives considered

- **Complete strict-schema adaptation first** — deferred because it is a separate provider-wide change; these cases have deterministic meanings and direct regression evidence.
- **Normalize all empty, null, or zero values** — rejected because such values can be meaningful input, including empty file contents and numeric limits.
- **Reject every populated inactive field** — rejected because the explicit action determines the goal operation, and unused fields cannot alter it.

## Consequences

The tools accept these calls without extra mutations. Unit tests cover ignored fields for every goal action, consumed-field and authority failures, stale revisions, filter validation, and real search results. A headless recorded-session scenario verifies both file extensions are searched and completion preserves the original objective and round cap. These rules give up detecting conflicting intent expressed only in inactive goal fields; they do not weaken authorization or establish a generic coercion policy.
