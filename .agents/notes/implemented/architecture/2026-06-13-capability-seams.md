# Agent Note: Capability seams — Service Definition / Service Provider / Consumer roles

Status: implemented

English | [中文](2026-06-13-capability-seams.zh.md)

## Problem

The harness has swappable capabilities, including shell execution and model providers. A capability has three concerns that change at different rates and for different reasons: the *contract* (what the capability is), the *implementation* (how it runs), and the *consumer API* (what the model and other plugins program against). Bundling them in one package couples those rates of change — swapping a local executor for a sandboxed one would churn the tool schemas the model sees, even though the model-facing contract never changed.

This is distinct from "who provides vs. needs a capability at runtime", which Cordis already answers with services + `inject` (a provider registers `ctx.shell`; a consumer declares `inject: ['bash']` and its fiber pends until the service exists). That mechanism is necessary but doesn't dictate package boundaries; this Agent Note does.

## Decision

A swappable capability has **three roles**:

1. **Service Definition** — the Cordis `Service` and vocabulary types owning `ctx.<key>` and depending only on the vocabulary the contract needs (e.g. `dsh-shell`: `ShellExecutor`, `ShellRunResult`, `ShellProcess`). A definition may be an abstract class or a concrete registry service; it is never a TypeScript `interface`.
2. **Service Provider** — a plugin that supplies or registers an implementation (e.g. `dsh-bash-local`: subprocesses, provider-managed range termination, spill-file truncation). The [native-containment decision](2026-08-28-subprocess-native-containment.md) owns the local provider's OS-specific range mechanics. Sandboxed and remote providers are sibling packages implementing or registering against the same Service Definition.
3. **Consumer** — what the model and plugins program against (e.g. `dsh-tool-bash`: the `bash` schema, with background handles registered into the generic job runtime). Consumers inject the service key and never import provider-specific types.

The role names use title case: **Service Definition**, **Service Provider**, and **Consumer**. Generic uses of `provider` and `consumer` remain lowercase.

Service Providers and Consumers then evolve independently: a sandboxed executor replaces `dsh-bash-local` without touching a tool schema.

Roles normally use separate packages when they evolve independently, but the split is not mandatory when the roles are genuinely one concern: the LLM seam folds Service Definition and Consumer into `dsh-llm` (the Consumer is the loop itself, not a swappable schema surface) with adapters as Service Provider packages. Don't split preemptively — a capability with one conceivable provider and one Consumer stays one package until a second appears.

## Terminology: "seam" names the trio, not the interface

A **seam** is the whole capability — the three roles together: a **Service Definition** (the Cordis `Service` that owns `ctx.<key>` and the vocabulary), one or more **Service Providers**, and one or more **Consumers**. `packages/shell` is the canonical example — `dsh-shell` / `dsh-bash-local`+`dsh-bash-sandbox` / `dsh-tool-bash`. A package may own multiple roles, but one role alone is not the seam. The term "seam" is reserved for this complete capability; name a constituent by its role, class, service, contract, or extension point. The [glossary](../../../../docs/glossary.md#capability-seam) is the canonical entry.

## Alternatives considered

- **Always combine the roles** — rejected because it recouples independently changing Service Definitions, providers, and Consumers.
- **`@cordisjs/plugin-capability`** — a different axis entirely: it is a permission/capability-*security* service (named permissions with inheritance, tested against a session via `ctx.capability.test`), a candidate for the deferred permissions/sandbox work on the `tools/pre-execute` deny/ask gate, NOT a mechanism for swapping implementations. Confusing the two ("capability") is the trap this Agent Note names.

## Consequences

Separating roles adds packages and boilerplate (`package.json`, `tsconfig`, README, and injection wiring). In return, Service Providers and Consumers ship and version independently, and a new backend never risks the model-facing contract. [AGENTS.md](../../../../AGENTS.md) and [architecture.md](../../../../docs/architecture.md) carry the rule; the bash trio is the reference template. This Agent Note records why independently changing roles normally split while genuinely shared concerns may remain folded.
