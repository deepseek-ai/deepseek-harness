# Agent Note: Centralize sparse first-party prompt-section orders

Status: implemented

English | [中文](2026-08-25-sparse-first-party-prompt-section-orders.zh.md)

## Problem

Repository-owned system-prompt sections declared unrelated numeric literals across more than twenty packages. The main tool sequence occupied consecutive values from 100 through 117 and then used half-step values for insertions. A later change could therefore collide with an existing section without seeing the complete allocation.

Equal orders used stable JavaScript sort behavior, which made plugin activation order the effective tie-breaker. The [Cordis/workflow prompt-order fix](../../archived/bug-fix/2026-08-24-system-prompt-section-order-ties.md) showed that clean compositions can activate the same plugins in different orders and produce different request headers and snapshot results. Fixing one collision locally did not prevent another package from reusing that value.

The shell guidance also followed filesystem guidance even though shell commands have the broadest execution and failure semantics. A model should read the shell result obligation before the narrower instructions that route file work to dedicated tools.

## Decision

`@deepseek-ai/dsh-system-prompt` owns private named allocations for repository prompt sections and runtime contexts. Every repository contributor asks the live service for its typed placement through `ctx.systemPrompt.getSectionOrder(name)` or `getContextOrder(name)` instead of importing a value or declaring a numeric literal. Section values are unique integers, and adjacent allocated section values differ by at least ten; context values are unique integers in their independent sequence.

The allocation preserves the established first-party sequence except for two deliberate changes: Bash, or PowerShell in the Windows composition, leads per-tool guidance; and sections that shared an order receive an explicit sequence. The groups are:

| Group | Entries |
|---|---|
| Product opening | `harness:identity` −1000, `harness:source` −900, `app:web-surface` −800, `deployment:persona` 0 |
| Work modes | `plan:policy` 500, `team:policy` 600 |
| Invocation prelude | `tools:ptc-only` 800, `context:file-reference` 900 |
| Local tools | `tool:bash` 1000, `tool:pwsh` 1010, `tool:read` 1100, `tool:write` 1200, `tool:edit` 1300, `tool:glob` 1400, `tool:grep` 1500, `tool:jobs` 1600, `tool:pty` 1700 |
| Higher-level tools | `tool:web_search` 2000, `tool:web_fetch` 2100, `tool:lsp` 2200, `tool:session-query` 2300, `tool:goal` 2400, `tool:cordis` 2500, `tool:workflow` 2600, `tool:ralph` 2700, continuable-subagent guidance 2800 |
| Generated protocol | `tools:sdk` 5000 |
| Final-output obligations | deliverable file references 9000, `tool:structured_output` 9900 |

The runtime-context allocation is `SANDBOX_POLICY` 110, `APPROVAL_POLICY` 115, and `SUBAGENT_DELEGATION` 120.

`SystemPrompt.assemble()` sorts equal-order sections by code-unit section name after comparing `order`. This makes third-party collisions deterministic without locale-sensitive comparison. First-party contributors still receive distinct ranks so their intended sequence remains explicit rather than depending on the fallback.

Dynamic `PromptContext` order and tool-schema `toolOrder` are separate sequences. Prompt contexts use the service's independent context allocation, while tool schemas remain under `toolOrder`. A scoped `deployment:persona` continues to shadow the global section by name before section sorting and resolves the same `DEPLOYMENT_PERSONA` placement through the service.

## Verification

The system-prompt unit suite resolves every configured section and context name through the service. It verifies integer and unique values, at least ten points between adjacent section values, and the same code-unit name order for opposite registration permutations of a tie. Real-composition snapshots pin the model-visible ordering, including Bash before filesystem guidance and the explicit Cordis, workflow, Ralph, subagent, and report sequence.

## Alternatives considered

**Keep package-local numeric literals and review collisions manually.** Rejected because a contributor cannot see the complete allocation locally, and the collision that motivated the earlier fix recurred after that fix merged.

**Continue inserting fractional values.** Rejected because fractions provide no durable spacing rule, obscure the semantic groups, and still permit unrelated packages to choose the same value.

**Normalize only snapshot comparisons.** Rejected because the runtime request header and model prompt would remain activation-order dependent while the test hid the difference.

**Preserve activation order for equal ranks.** Rejected because activation order is not a prompt-order decision and varies across valid compositions. Name order is deterministic for external collisions; explicit named placements carry first-party intent.

**Put dynamic contexts and tool schemas in the section allocation.** Rejected because they are independently assembled sequences. Contexts receive their own named service allocation; combining either sequence with sections would imply cross-sequence ordering that the runtime does not perform.

## Consequences

Numeric ranks are not rendered, so the renumbering alone does not change model text. Bash or PowerShell moves before other per-tool guidance, and previously tied sections acquire deterministic order; those model-visible changes update request-header snapshots and may invalidate provider prefix reuse from the first moved paragraph.

An external plugin can choose any finite numeric order for its own section or context. Named order lookups are repository-owned placements rather than an extension API. Equal external section ranks remain supported and deterministic by name.

The system-prompt package now knows the names and relative placement of repository features. That centralized coupling is deliberate: the registry already owns the ordering semantics, while distributed numeric literals made the same relationship implicit and uncheckable.
