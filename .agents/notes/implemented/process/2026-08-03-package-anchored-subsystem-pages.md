# Agent Note: Package-anchored subsystem pages and thin group READMEs

Status: implemented

English | [中文](2026-08-03-package-anchored-subsystem-pages.zh.md)

## Problem

The [subsystems catalog](../../archived/process/2026-06-20-core-data-structures-catalog.md) scoped its front page by the spine-vs-seam rule: a type was "core" if the loop holds, derives, streams, or logs it on every turn. That rule selected types, not packages, so as the folder grew to forty-plus pages the front page became a cross-package grab-bag: LLM conversation vocabulary sat above the agent contracts, the creation/ownership vocabulary (`AgentHandle`, `CreateAgentOptions`, `ResumeAgentOptions`, `AgentFactory`) was documented nowhere in the folder because the generator exempted it to a package README, and a reader could not predict which page documents a type from where the type lives. Package-group READMEs meanwhile had no common shape — some carried sectioned tables, stray design essays, or trailing paragraphs that belonged on a subsystem page.

## Decision

Every `docs/subsystems/` page anchors to the package or package group that declares its vocabulary, and page membership follows the repository layout: [core.md](../../../../docs/subsystems/core.md) is the `packages/core` page (creation and ownership, the `Agent` handle with its delivery/cancellation/interception contracts, pointers to the group's dedicated pages), [llm-streaming.md](../../../../docs/subsystems/llm-streaming.md) owns `packages/llm` end-to-end, and so on. Repo-wide type patterns (`…Map → derived-union`, branded ids) stay on core.md in an explicitly framed closing section rather than interleaved with the package content. This supersedes the spine-vs-seam rule *as the page-scoping rule*; the placement heuristic that survives is simpler: a type is documented where its declaring package's page is, and machinery keeps living with its machinery.

Every type a generated signature references must resolve somewhere in the folder: the agent ownership vocabulary moved from the generator's `TYPE_LINK_EXEMPTIONS` into `LINK_MAP → core.md`, so exemptions are reserved for genuinely service-local or vendored shapes. Each pasted declaration has one home (`SessionEvent` lives on [session.md](../../../../docs/subsystems/session.md); core.md summarizes and links).

Every `packages/<group>/README.md` pair is a thin entry point in one shape: a why-first intro paragraph, a package table (Package / Role / ctx key), and a closing pointer to the owning subsystems page. A group that declares no standalone subsystem reference is instead classified with a non-empty rationale in `GROUPS_WITHOUT_SUBSYSTEM_PAGE`. Load-bearing prose that outgrows that shape relocates to the owning subsystems page rather than being deleted.

`verify-subsystem-pages` discovers groups from both group READMEs and child package manifests. It rejects a missing group README, a group with neither a reader-visible direct link to one English file under `docs/subsystems/` nor an explicit exemption, a blank or orphaned exemption, an exempt group that gains a link, and a link whose page is absent; code, comments, images, nested paths, and traversal do not satisfy ownership. The check runs as an independent `doc-sync` leaf, so adding a package group cannot silently omit its documentation owner.

The [subsystems README](../../../../docs/subsystems/README.md) indexes every page in the folder on both language sides; `scripts/project-doc-site.spec.ts` enforces one table row per page, so an added or merged page cannot silently miss the index.

## Alternatives considered

**Keep the spine-vs-subsystem scoping rule.** It answered "is this type core?" per type, which is why the front page accumulated types from four packages while missing half of `packages/core/agent`'s public API. Predictability by repository layout won.

**A flat single-document catalog.** Already rejected in the [original catalog note](../../archived/process/2026-06-20-core-data-structures-catalog.md); the growth to forty-one pages confirmed that verdict.

**Document ownership vocabulary only in package READMEs (the exemption status quo).** This left `AgentHandle` and the create/resume options invisible to the folder that claims to be the type reference, and the generated `Types:` footers could not link them.

## Consequences

- Which page documents a type is predictable from `packages/<group>/`; the subsystems README is a complete index enforced by test.
- Every package group makes its subsystem owner or justified absence reviewable, and `verify-subsystem-pages` rejects unclassified additions and stale exemptions.
- Generated signature footers link the agent ownership vocabulary instead of silently exempting it.
- `verify-type-equiv`'s 1:1 manifest keeps each paste single-homed; the duplicate `SessionEvent` paste is gone.
- The [original catalog note](../../archived/process/2026-06-20-core-data-structures-catalog.md) remains the owner of the `ts type-equiv` drift-gate mechanism; only its page-scoping rule is superseded here.
