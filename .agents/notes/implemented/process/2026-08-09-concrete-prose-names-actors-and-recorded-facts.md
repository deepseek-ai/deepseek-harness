# Agent Note: Concrete prose names actors and recorded facts

Status: implemented

English | [中文](2026-08-09-concrete-prose-names-actors-and-recorded-facts.zh.md)

## Problem

Repository prose used abstract category labels where readers needed different concrete facts. The same label could mean earlier event seqs cited by a replacement, the provider and model that produced a message, the caller that supplied context, the file that supplied a configuration row, or the CI job that built a binary. Readers had to inspect code before they could tell which fact the sentence promised.

Replacing one broad label with another would preserve that ambiguity. Renaming types, fields, and protocol members during an editorial cleanup would instead change contracts that the wording problem did not require changing.

## Decision

Maintained prose names the exact actor, action, source, event, field, file, or process needed by the local contract. It states what was recorded and who or what recorded it. Writers apply a spoken-language check and replace words they would not use while explaining the same point to a colleague.

The rule applies to Markdown, READMEs, active Agent Notes, JSDoc and comments, prompts, diagnostics, and user-visible strings. An audit judges each sentence separately; it does not replace a term across the repository with one preferred synonym. The edited sentence preserves actor, action, conditions, order, modality, exceptions, ownership, failure behavior, and consequences.

Comments retain only facts that nearby code cannot express. Documentation stays at its owning level and omits private control flow and rare implementation cases unless they change supported behavior, safe use, compatibility, data integrity, security, or another maintained contract. The [simplification workflow](../../../skills/dsh-find-simplifications/SKILL.md) applies this rule while surveying code and prose together.

Exact code identifiers, public APIs, durable fields, protocol members, type names, headings with external references, and filenames stay unchanged unless a coordinated contract rename is independently required. Surrounding prose explains their fields or behavior directly. Generated documents and catalogs update from their owning source.

Before using `contract`, `boundary`, or `shape`, writers check whether the sentence means a more specific rule, operation, data structure, field set, validation point, timing point, API, type, or failure condition. `Contract` remains correct for preconditions, postconditions, invariants, compatibility promises, and other obligations that callers, callees, implementers, providers, producers, or consumers rely on. `Boundary` remains correct for a literal security, trust, wire, process, serialization, transaction, or lifecycle division. `Shape` remains correct when the structural form itself is the subject and no narrower term such as fields, schema, type, union variant, file layout, or export form states the fact. Code and API names containing these words remain unchanged unless a separate coordinated rename is required.

This decision complements the [documentation tiers and budgets](2026-07-04-doc-tiers-and-budgets.md) decision, which continues to own placement, document form, and word budgets.

The [blocked ambiguous origin label](2026-08-26-ban-ambiguous-origin-label.md) decision partially supersedes the sentence-level policy for one term after that term spread across unrelated contracts.

## Alternatives considered

**Ban a fixed list of words.** Rejected because a word may be an exact identifier or the clearest term in another contract. For example, caller/callee invariants are real contracts, and process or wire boundaries identify real divisions. Sentence-level review catches ambiguity without rejecting valid names.

**Replace every abstract label with “source,” “origin,” or “metadata.”** Rejected because another broad label still leaves readers to infer whether the sentence means a file, caller, event seq, provider/model pair, commit, or build job.

**Rename every matching identifier with the prose.** Rejected because editorial clarity does not justify unrelated API, protocol, durable-format, type, or file migrations. Those changes require their own consumer audit and decision.

## Consequences

Documentation and diagnostics may use a few more words, but each statement tells readers which value or process matters without requiring source inspection. Repository-wide prose audits require semantic classification and cannot use blind replacement. Bilingual counterparts preserve the same concrete fact, and generated copies are refreshed only after their owning source changes.
