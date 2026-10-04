# Agent Note: Package Model Experience contract

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-12-package-model-experience-contract.zh.md)

## Problem

A package README can explain APIs and runtime mechanics without answering the questions that dominate an agent harness's behavior and cost: what from this package reaches a model request, under which conditions, how long those tokens remain, and whether later requests preserve a reusable KV-cache prefix. The omission is especially hard to audit in a plugin architecture. A consumer may turn a backend result into a tool message, a policy plugin may replace success with an error, compaction may remove old history, and an agent-scoped registration may change one agent's prompt or schemas while leaving every other agent unchanged. Reading only the nominally model-facing packages therefore misses real context effects, while reading source across every dependency is too expensive for routine review.

## Decision

Every workspace package README with a model-facing or model-adjacent contract ends with the canonical [Model Experience section](../../../../docs/cookbook/adding-a-package.md#4-write-the-package-readme), immediately before `## Known Limitations and Deferred Work`; a package on the no-limitations allowlist ends with Model Experience itself. An audited model-agnostic generic package omits the section through `NO_MODEL_EXPERIENCE_SECTION`.

Packages with direct, conditional, capped, lifetime, multi-surface, or auxiliary-model effects use one H3 per context surface. Each surface contains three ordered H4 fields—`What the model sees`, `Token effect`, and `KV Cache effect`—and each field starts with one prose paragraph. The cache field distinguishes append-only growth, a stable repeated prefix, replacement of earlier tokens, and an independent model request; it names every package-owned configuration, scope, lifecycle, compaction, or routing change that can alter the request before newly appended content. “Does not invalidate” means the package preserves an already-reusable prefix, not that a provider promises a cache hit or retention period. Stable package-owned text is quoted exactly: system-prompt prose and other long literals use a titled H5 plus `markdown` fence under the field that introduces them, normally `What the model sees`, while short literals stay inline with named interpolation placeholders. Tool-schemas link their anchored section in the generated [tool catalog](../../../../docs/tool-catalog.md) and state only composition or configuration deltas; runtime-only definitions explain why the catalog omits them. Data-dependent and provider-owned text is summarized. Agent-scoped visibility is explicit, and prompt and schemas remain separate when scoping can hide one without the other.

A package with no model-context effect, or one path rendered entirely by another package, uses the verifier's audited short form: one sentence beginning `None, as ` or `Indirectly, through ` followed by a `KV Cache effect` H4 and one prose paragraph. Pure transport and keyless test-support packages use the none form when they create no model-bound content. Provider backends use the indirect form even when they cap or filter data, and wiring bundles use it when named children own every effect. These sections locate the contribution and disclaim direct cache invalidation without restating the consumer. Structured sections likewise document only package-owned inputs, transformations, and deltas.

`verify-package-readme-model-experience` discovers package manifests and validates the three classifications, canonical final-section order, exact field heading depth and order, non-empty field paragraphs, H5 ownership of verbatim blocks, concrete literal evidence, and anchored tool-catalog links. It runs in `doc-sync` and the parallel gate runner. Review still owns coverage, link relevance, and factual accuracy.

## Alternatives considered

- **Document only packages that register prompts or tools** — rejected because backends, policy plugins, adapters, persistence, scoping, and compaction change the content or lifetime of tokens without owning a model-facing schema.
- **Generate one central context-cost catalog from source** — rejected because an AST can find registrations but cannot infer semantic conditions such as history retention, output truncation, parent-versus-child visibility, or an auxiliary model boundary. The package README is the implementation-local contract; a central copy would add another drift point.
- **Require numeric token counts** — rejected because exact counts depend on the selected model tokenizer, adapter serialization, configuration, and runtime data. The stable contract is the growth shape: fixed per request, conditional per call, retained, replaced, capped, or zero-direct.
- **Use a table** — rejected because exact source text and conditional result shapes make cells dense and difficult to scan. Repeated subsections give each context surface readable vertical space while preserving the same fields.
- **Allow every zero-impact package to omit the section** — rejected because unconstrained absence is ambiguous between an audited zero and forgotten documentation. Omission is reserved for model-agnostic generic packages named with a reason in the verifier; model-adjacent zero-impact packages keep one explicit sentence.
- **Require the full structured form for audited zero or simple indirect packages** — rejected because it repeats labels around one fact. A gated sentence plus cache field preserves explicit coverage without the ceremony.
- **Convention without a gate** — rejected because a repo-wide contract must also cover every future package; review memory cannot reliably detect an omitted README section.

## Consequences

A reviewer can start at any model-facing or model-adjacent package and see its contribution to the conversation model, child models, and auxiliary calls without reconstructing the full plugin graph. Token-budget work can distinguish repeated request overhead from data-dependent history, while cache-sensitive work can identify append-only paths and the earliest package-owned prefix mutation. Agent-scoped changes have an explicit documentation checkpoint. Package authors maintain one or more compact context-entry blocks or one classified short form whenever model-visible behavior changes; audited generic packages carry no irrelevant model boilerplate. The structured fields do not promise provider-exact token counts or cache hits; measurements remain model-, provider-, and workload-specific, while the documented growth, visibility, and prefix-stability contract stays stable.
