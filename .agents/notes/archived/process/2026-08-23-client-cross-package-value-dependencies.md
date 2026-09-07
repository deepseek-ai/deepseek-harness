# Agent Note: Classifying Client cross-package value dependencies

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-23-client-cross-package-value-dependencies.zh.md)

## Problem

The Client package splits in [PR #2728](https://github.com/deepseek-ai/deepseek-harness/pull/2728) and [PR #2911](https://github.com/deepseek-ai/deepseek-harness/pull/2911) left 15 `dsh.client.external` requests in feature-plugin manifests. Those requests turned ordinary value imports into synchronous module-table ordering constraints, even when the consumer needed only a type, a small pure conversion, or access to an already-injected Cordis service.

Removing every import mechanically would create different coupling: a general utility package could become a miscellaneous business owner, a service could carry pure presentation transforms, or duplicated target behavior could be centralized only to satisfy clone detection. Client maintenance needs one repeatable classification before choosing where a cross-package reference belongs.

## Decision

Every Client cross-package reference is classified by what crosses the package boundary. A feature plugin does not import a runtime value from another feature plugin and does not declare `dsh.client.external`. The [Client shell layering decision](../architecture/2026-08-15-client-shells-and-dynamic-packages.md) continues to own bundle construction and module-table loading; this decision narrows how feature code uses those mechanisms.

| Case | Treatment | Reason |
| --- | --- | --- |
| Unused value or forwarding export | Delete it | A dependency without a caller has no owner to preserve. |
| Shared declaration | Import it with `import type` from the declaring package | Erased imports retain one type authority without a runtime edge. |
| Stateful, lifecycle-bound, or callable feature behavior | Expose it through an injected Cordis service | The providing plugin owns implementation and lifecycle; consumers depend on the service name and interface. |
| Presentation contribution | Register it through the declaring slot | The owner controls placement while contributors remain independently loadable. |
| Generic stateless helper or primitive | Put it in a narrow static utility package or `ui-primitives` | Multiple packages may synchronously share behavior only when it has no feature state, lifecycle, or domain authority. |
| Small target-specific projection | Keep one local implementation in each target | Chat and Trajectory may intentionally interpret the same durable event independently; sharing code alone does not justify a feature dependency. |
| Generated Remote artifact | Import it only in the API transport assembly that owns generated registration | Generated providers are transport wiring, not a feature package's callable helper API. |

Intentional target-local copies wrap only the duplicated implementation in `jscpd:ignore-start` / `jscpd:ignore-end`, with a comment naming the independent owners. The exclusion must not cover surrounding business logic. Generic behavior moves to a utility only when its semantics are stable outside every current caller; this cleanup places Workspace path formatting in `dsh-util-workspace-path`, byte encoding in `dsh-util-crypto`, and the shared reference glyph in `ui-primitives`.

`verify-client-packages` rejects every `dsh.client.external` declaration under `packages/client/*`. Outside that feature tree, each declaration must correspond to a production runtime import or re-export. The two retained requests are Session Controller → API Gateway and Workspace Controller → API Gateway; both are transport infrastructure. The Client bundle preset separately rejects workspace runtime imports that are neither module-table requests nor explicitly allowlisted static inputs.

Host-facing transport adapters remain outside the feature-plugin prohibition. Connection may use API Proxy's carrier implementation, and `api/remotes` may load a generated Host Remote provider. These imports assemble transport rather than sharing feature behavior.

## Alternatives considered

**Put every reused value on `uiConversation`.** Rejected because pure event-to-view conversions would become service calls or feature exports, forcing Chat, Trajectory, Approval, Question, Subagent, and Workspace to load an unrelated feature owner.

**Keep feature `dsh.client.external` declarations.** Rejected because successful loading would preserve the synchronous value dependency and merely make its ordering explicit.

**Move every repeated function into one utility package.** Rejected because target-specific interpretation would acquire a false shared owner. Only state-free behavior with meaning independent of its callers belongs in a static utility.

**Ignore all duplicate Client code.** Rejected because duplication remains useful evidence by default. An ignore is narrow and documents the deliberate independence of named targets.

## Consequences

The 15 feature-plugin external requests are absent, while shared declaration imports remain explicit and type-only. Feature loading order follows Cordis services and slots instead of synchronous feature-module imports.

Some short projection functions exist twice. Their owners can evolve independently, and clone detection still covers all code outside the annotated copies. Static utility packages gain a small public API and must remain state-free and browser-safe.

The rule is role-specific rather than a blanket ban on cross-package values. Infrastructure adapters and generated registration artifacts remain direct imports where loading or protocol assembly requires them, and `verify-client-packages` keeps those exceptions visible and live.
