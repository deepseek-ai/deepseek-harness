# Agent Note: Product subagents expose minimal actionable diagnostics

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-product-subagent-minimal-diagnostics.zh.md)

## Problem

The Claude Code and Codex providers receive structured failures from independently versioned product runtimes. Mirroring every member of those upstream error unions into model-visible diagnostics makes each runtime upgrade expand the Provider contract even when the parent agent would take the same next action for several categories.

Raw SDK errors, app-server payloads, stderr, commands, paths, task content, environment values, and credentials cannot replace the structured mapping because they cross the product process boundary without a stable safety guarantee. The parent still needs enough information to distinguish a product limit, access restriction, service or transport problem, invalid result, and managed process failure.

## Decision

Each product Provider derives a small action category from the current operation and safe structured product facts. The existing `SubagentResult.diagnostic` string remains the only public representation: consumers display it but do not parse it, and the shared subagent result boundary continues to enforce the complete 4096-byte UTF-8 limit.

Claude Code maps Agent SDK results into five categories:

| Category | Safe input |
| --- | --- |
| `limit` | Turn, budget, or structured-output retry limits |
| `product-error` | A general SDK execution failure |
| `invalid-result` | An error-marked or blank success, or no terminal result |
| `process` | The managed CLI exits before a terminal result |
| `unknown` | Startup, teardown, unrecognized SDK values, or failures without a more specific safe fact |

The diagnostic also retains the derived `query-start`, `query-run`, `process`, or `teardown` stage and independently observed exit code and signal. A contributing permission decision follows the failure line. Successful completion and local cancellation expose no failure diagnostic, and original SDK text remains only on the internal cause chain and in Host observation.

Codex maps app-server failures into eight categories:

| Category | Safe input |
| --- | --- |
| `limit` | Context, session-budget, or usage limits |
| `access-policy` | Authentication, cyber-policy, product-policy, or sandbox failures |
| `service` | Overload or internal service failures |
| `transport` | HTTP and response-stream connection failures or exhausted attempts |
| `product-error` | Invalid requests, rollback, active-turn, or other product failures |
| `invalid-result` | A completed turn without a nonblank final answer |
| `process` | The managed app-server exits before another terminal result |
| `unknown` | Startup, teardown, malformed protocol values, or failures without a more specific safe fact |

The Codex diagnostic retains `initialize`, `thread-start`, `turn-start`, `turn`, `process`, or `teardown`, plus applicable numeric HTTP status and independently observed exit code and signal. `contextWindowExceeded` still maps the shared stop reason to `max-tokens`; every other category remains `error`. Only structured protocol facts contribute permission detail. Product stderr is Host-only observation and is neither classified nor copied into the result.

### Ownership and lifecycle

| Fact or operation | Owner | Result |
| --- | --- | --- |
| Product error interpretation | Official product runtime | The Provider consumes only structured facts exposed by its pinned integration |
| Action category and stage | One product Provider run | Derived at the failure site and discarded after result settlement |
| Exit code and signal | `dsh-subprocess` handle | Displayed independently when observed, without inferring missing values |
| Permission decision | Product Provider permission callbacks or protocol | Appended only when it contributed to the failed run |
| Diagnostic delivery and byte limit | `dsh-subagent` and its foreground or Job consumers | One bounded optional string remains separate from assistant output |

## Verification

Claude Code package tests cover every coarse category, all four stages, unknown structured values, permission ordering, raw-text exclusion, success and cancellation omission, concurrent-run isolation, and independent exit code and signal fields. The real Agent SDK 0.3.241 and Claude Code 2.1.241 fixture produces an actual max-turns limit, process failure, permission denial, strict final answer, cancellation, and whole-tree quiescence. Codex package tests cover every coarse category, all six stages, applicable HTTP status, structured permission ordering, stderr exclusion, success and cancellation omission, concurrency, and cleanup aggregation. The real 0.149.1 app-server fixture produces service, product-error, process, final-answer, model-isolation, cancellation, and quiescence evidence. Loader and keyless product compositions continue to expose static tools without a diagnostic parser or model-visible category input.

## Alternatives considered

**Preserve every upstream enum member.** Several members lead to the same parent action, while the display-only consumer gains no behavior from their exact names. Keeping them would make routine product upgrades redefine a larger Harness-facing promise.

**Return raw product text or classify general stderr.** Free-form text can contain sensitive task and environment data and has no stable versioned meaning. Only structured product facts, Provider stage, permission decisions, and managed process outcomes qualify as input.

**Add a shared structured error type.** The products version their failures independently, and current consumers only present a bounded string. A shared enum would move product release churn into the provider-neutral seam without a consumer that needs it.

**Retry or fall back based on the category.** The Provider owns one one-shot run and has no retry authority, fallback model, persistent product session, or recovery state. The category informs the parent; it does not start another product action.

## Consequences

Product runtime upgrades no longer require a model-visible promise for every SDK or app-server error member. Parents still distinguish limits, access and policy restrictions, service and transport failures, general product failures, invalid results, managed process exits, and unknown failures while retaining applicable stage, permission, HTTP, and process facts.

The diagnostic remains safe display text rather than a recovery protocol. This change adds no raw error forwarding, fallback model, automatic retry, product session persistence, public structured result field, or dynamic provider and model selection.
