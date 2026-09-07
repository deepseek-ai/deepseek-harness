# Agent Note: Capability-neutral sandbox policy context

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-capability-neutral-sandbox-policy-context.zh.md)

## Problem

The current-policy context originally mirrored runtime composition through separate enforced-family and escalatable-family registries. Six backend, tool, and example call sites contributed `filesystem`, `bash`, or `terminal`; the policy service retained token sets for independent disposal, intersected and ordered the two registries, invalidated prompt assemblies on every lifecycle change, and tested every family combination.

That inventory was neither needed to state the file policy nor authoritative for model-visible capability. A backend contribution could name a family whose model-facing tool was absent or hidden by request scope, while tool schemas already told the model which exact operations were available. The registries therefore widened the public service and lifecycle contract to maintain an approximate English sentence.

## Decision

`dsh-sandbox-policy` contributes one capability-neutral `sandbox:policy` context for every agent session. It derives the text only from `resolve({ session })`; there is no backend or tool family registration API, contribution map, ordering rule, or registration-driven prompt invalidation.

The text conditions capability claims on available operations that the DSH file sandbox enforces. Under `read-only`, it states that such operations cannot modify files in the standing mode and tells the model to try an available tool normally, then follow any denial and escalation guidance that tool returns. Under `workspace-write`, it states the canonical session workspace and the qualified temporary-area allowance. Under `danger-full-access`, it states that the DSH file sandbox does not restrict file modifications by available operations.

Tool schemas remain the authority for which operations are available. Tool results remain the authority for operation-specific denials and approved wider retries. Filesystem, one-shot bash, and terminal implementations continue to resolve and enforce the same per-call policy; only the redundant model-facing capability inventory is removed.

This decision partially supersedes the family-registration and composition-conditioned wording in [the current sandbox policy context decision](../feature/2026-07-30-current-sandbox-policy-context.md). That note remains the owner of cache-safe context delivery, durable snapshot materialization, wording evidence, and the separation between guidance and enforcement.

## Alternatives considered

**Keep the registries but reduce their tests.** Rejected because the public methods, retained lifecycle state, six contribution sites, and approximate capability claim would remain. The combinatorial tests reflected the design cost; they did not create it.

**Derive an exact inventory from the tool registry.** Rejected because current policy needs only a truthful conditional statement, while exact availability already appears in the assembled tool schemas and can vary by request scope. Mapping each schema back to an enforcement backend would introduce another derived relation with no current consumer.

**Omit policy context unless a backend advertises enforcement.** Rejected because it recreates the registration problem and makes policy visibility depend on optional contributors. The conditional wording remains truthful even when no applicable operation is available.

## Consequences

The policy service has one owner-derived context path instead of two public registries and their disposal lifecycle. Capability additions and removals no longer churn the runtime-context snapshot, while mode and workspace changes still do. Exact mode wording, canonical roots, switching, resume, service disposal, and no-agent assembly remain covered; family-combination and contribution-lifecycle tests disappear with the behavior they protected.

The model no longer receives a prose list of sandboxed capability families. It receives exact tool schemas plus one standing file-policy statement. If a future product needs a separate capability inventory, it must be derived from the authoritative per-request assembly rather than reconstructed through backend registration side channels.
