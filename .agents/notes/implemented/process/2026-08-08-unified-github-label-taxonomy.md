# Agent Note: Unified GitHub label taxonomy

Status: implemented

English | [中文](2026-08-08-unified-github-label-taxonomy.zh.md)

## Problem

Pull request labels answer two independent questions: what kind of change the work makes and which durable repository domains it materially affects. Mixing those dimensions or retaining synonymous plain and namespaced labels makes queries ambiguous, while a closed area inventory forces new domains into inaccurate categories.

Issues already have a native Type and a separate source taxonomy. Reusing pull request kind or source labels across both object types duplicates metadata and weakens the meaning of each family.

## Decision

Every open or merged pull request carries exactly one canonical `kind/*` label and at least one materially affected `area/*` label. Closed pull requests that were never merged retain migrated historical assignments but do not receive invented missing classification. Operational labels may coexist without satisfying either dimension.

### Kinds

The kind set is closed and mutually exclusive:

| Kind | Meaning |
|---|---|
| `kind/feature` | Adds or intentionally changes behavior. |
| `kind/bug-fix` | Corrects incorrect behavior. |
| `kind/doc` | Makes documentation the dominant intent. |
| `kind/testing` | Changes tests or testing infrastructure without changing product behavior. |
| `kind/cleanup` | Preserves behavior while maintaining or simplifying implementation or repository process. |
| `kind/dependency` | Updates dependencies without another dominant intent. |

The kind records the dominant intent. Accompanying tests, documentation, cleanup, or dependency movement do not override a feature or bug fix. A new kind changes these classification rules and requires an explicit taxonomy and policy change.

Repository policy rejects unsupported `kind/*` values and reserves every alias removed by the unification: `kind/bug`, `kind/documentation`, `feature`, `bug-fix`, `doc`, `cleanup`, `testing`, `dependencies`, `ci`, `cli`, `llm`, and `web-search`. Reserving the exact migrated set prevents an obsolete synonym from being recreated as an apparently unrelated operational label.

### Areas

Areas name durable product or engineering subjects rather than temporary initiatives, ownership, or every path touched incidentally. A pull request carries multiple areas when it changes distinct behavior or APIs, but it does not combine an umbrella and a narrower label for the same change. GitHub's live `area/*` names and descriptions own the current inventory; this record defines selection cases that cannot fit reliably in short label descriptions.

- `area/web` covers browser and Electron graphical interfaces, `area/vscode` covers the editor extension, and `area/api` covers cross-interface protocols and language SDKs.
- `area/planning` covers goals, plans, todos, and scheduling, while `area/workflow` covers executable workflows and background job runtimes.
- `area/artifact` deliberately combines artifacts, attachments, and multimodal delivery. Split labels become justified only when those concerns again need independent review or queries.
- `area/tools` applies to generic registry, schema, and execution contracts. A concrete capability uses its own area unless it also changes one of those contracts.
- `area/hooks` means the Claude Code and Codex bridges, `area/infra` covers build, release, CI, repository gates, generators, dependencies, and developer tooling, and `area/windows` covers native Windows product support rather than CI runner selection.

The area set is intentionally extensible. When no existing description honestly covers a durable and reusable domain, an agent may create a concise `area/<lowercase-kebab-case>` label without separate approval. It must not create an area for one pull request, an incidental path, a temporary project, a status, or a person or team, and it reports the new label and rationale to the requester after applying it. Reusing an inaccurate area merely to avoid a justified addition is not acceptable.

### Issues and migrations

Issues use native Issue Type instead of `kind/*`; their `area/*` labels remain optional. `source/*` labels record how an Issue was created and do not apply to pull requests. Priority, GitHub defaults, and workflow triggers remain independent operational metadata.

The repository lifecycle removes pull request `kind/*` labels and reserved aliases from an Issue before auditing it. Policy comments report only violations whose intended value cannot be derived from the Issue, such as a missing native Type or an unsupported Priority.

Label migrations preserve meaning before removing aliases: add the canonical replacement, verify the labelable, then remove the obsolete assignment. A label is deleted only after no pull request or Issue still uses it, and unrelated labels are never replaced as a set.

## Alternatives considered

**Unprefixed labels.** Plain names reduce visual noise, but they do not identify whether a label classifies intent, domain, source, priority, or automation. Retaining both plain and namespaced synonyms also makes queries and policy enforcement ambiguous.

**One undifferentiated label set.** A label's presence would not prove that both intent and semantic scope were considered.

**A fixed area allowlist in repository policy.** Durable repository domains evolve. The `area/*` namespace remains mechanically recognizable while live descriptions carry the extensible inventory.

**Package- or path-derived areas.** Areas describe semantic impact across package boundaries, while changed paths include incidental tests, documentation, and support files.

**Separate labels for every delivery shell or media lifecycle.** Browser and Electron delivery share one graphical domain, and artifact, attachment, and multimodal delivery currently share one review/query domain. A split belongs in a later taxonomy change only when it restores useful independent classification.

**Broad implementation labels in place of product or engineering subjects.** A concrete capability is not merely its tool, interface, filesystem, or process implementation. Generic implementation areas apply only when their own behavior or API changes.

**Kinds on Issues.** Native Issue Type already owns that classification; duplicating it as a label creates drift.

**Comment-only Issue enforcement.** A comment preserves invalid metadata and requires human cleanup even when the only valid result is removal. The lifecycle applies that removal and retains comments for choices it cannot infer.

**Exactly one area per pull request.** Coherent changes can materially affect several independent APIs or behaviors, and dropping secondary areas hides affected scope.

## Consequences

Reviewers and automation can query intent, semantic scope, how an Issue was created, priority, and operational triggers independently. Invalid Issue labels disappear without a policy comment, and the label event records the repair; when no other violation remains, the lifecycle deletes any earlier policy comment. Maintainers must read the change and the live label descriptions instead of inferring classification from title prefixes or paths. The live catalog, this rationale, and policy enforcement must move together when a kind or a non-obvious area boundary changes, and taxonomy migrations carry an explicit historical backfill and verification cost.
