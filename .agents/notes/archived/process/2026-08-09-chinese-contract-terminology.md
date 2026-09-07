# Agent Note: Standardize Chinese contract terminology on 约定

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-chinese-contract-terminology.zh.md)

## Problem

The Chinese documentation rendered English `contract` inconsistently as `契约` and `约定`, sometimes within one file or paragraph. The terminology table prescribed `契约`, while reviewed incremental proofreading selected the more natural engineering rendering `约定`. Leaving the table and corpus split made either choice fail the repository's terminology rule and allowed later translations to reintroduce the disagreement.

English `convention` also commonly renders as `约定`. That overlap is intentional: ordinary Chinese engineering prose uses `约定` for both concepts, and context normally carries whether a statement is descriptive practice or a binding interface rule. Where an English sentence explicitly contrasts a convention with a contract, the Chinese sentence must preserve the distinction through wording such as `惯例` versus `约定`, rather than mechanically giving every `convention` the same rendering.

## Decision

The terminology source of truth defines `contract` as `约定` and `adapter contract` as `适配器约定（adapter contract）` on first mention. Every active Chinese documentation pair follows that ruling; archived Agent Notes remain frozen. Unpaired bilingual calibration assets and the translation prompt's explanatory prose follow the same terms so they cannot teach the superseded rendering.

The migration is semantic prose maintenance, not a rename of identifiers. Inline code, file paths, links, API names, English filenames containing `contract`, and machine-readable values remain unchanged. `convention` does not receive a global terminology row or corpus-wide rewrite: translators preserve natural Chinese and explicitly disambiguate only where the source contrasts the two concepts. The [concrete prose decision](2026-08-09-concrete-prose-names-actors-and-recorded-facts.md) separately decides when English prose should replace a vague `contract` use with the exact rule, API, or behavior before translation.

## Alternatives considered

**Keep `contract` as `契约`.** Rejected because the reviewed corpus consistently preferred `约定` for technical interfaces, lifecycle guarantees, and behavioral boundaries, and maintaining the older term would require reverting accepted proofreading across many documents.

**Give `convention` a mandatory global rendering.** Rejected because its meaning ranges from naming practice to protocol convention. A single forced term would create a second broad migration without improving ordinary prose; only explicit source contrasts require a distinct rendering.

**Permit both `契约` and `约定` for `contract`.** Rejected because it preserves the exact inconsistency that made package families and even individual paragraphs disagree.

## Consequences

Active Chinese documentation has one binding rendering for `contract`, and future translation prompts receive that decision directly from the terminology table. Archived records keep their historical text. A source sentence that contrasts convention and contract requires local semantic wording, so equal Chinese dictionary choices never erase a distinction the source actually uses.

## Verification

The migration scans every active bilingual pair, updates each affected Chinese document, re-records its pairing sidecar, and leaves active prose with no `契约` occurrences. The pairing gate, full `doc-sync`, website build, translation prompt tests and snapshot, and `git diff --check` verify the resulting corpus and pipeline assets.
