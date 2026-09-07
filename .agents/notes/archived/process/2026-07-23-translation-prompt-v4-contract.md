# Agent Note: Calibrated translation prompt v4 contract

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-23-translation-prompt-v4-contract.zh.md)

## Problem

Automated counterpart generation needs a stable prompt that reproduces the register and corrections established by human-reviewed translations. Injecting a general-purpose instruction document changes that calibrated model input whenever human or agent guidance changes, while an unframed response cannot carry a draft, its self-review, and the corrected document separately. Plain XML-like section tags also collide with valid Markdown that documents those same tags.

## Decision

The committed [translation prompt](../../../../docs/i18n/translation-prompt.md) is the calibrated pipeline asset. Its renderer injects only the source language, target language, and current [terminology table](../../../../docs/i18n/terminology.md), and rejects unknown, missing, or malformed placeholder syntax before assembling a request. The request assembler retains the source basename outside the model-visible prompt and places each reviewed whole-document pair into one bare-text user/assistant example turn before the real source document. The template may carry model-specific calibration rules, but those rules remain subordinate to the repository's pairing, terminology, structure, and emphasis contracts.

The v7 calibration retains that v4 protocol and makes the instruction priority explicit: source meaning and protected structure, then the terminology table, then whole-document gold-pair voice, then general guidance and embedded examples. It directs the model to draft as a native technical author and then compare clause by clause, preserving actors, conditions, negation, modality, lifecycle conditions, direction, result channels, ownership, and quantities. Style guidance cannot invent an actor or vary a terminology-table form, defined concept, or contract verb merely for variety. Unresolved terminology stays unchanged in the translation and is reported only as pending review.

The response has three ordered top-level sections: `translation`, `review`, and `final`. The response consumer derives the target basename from the retained source context, preserves optional leading YAML frontmatter, and mechanically inserts or corrects the language switcher after the first H1 in `final`. The parser requires each section exactly once, rejects content outside the envelope, and tolerates one outer `xml` Markdown fence because models sometimes echo the prompt's example fence.

## Response framing

Section delimiter lines are reserved by the wire format. When a Markdown body line consists of a delimiter tag, possibly preceded by backslashes, the serializer and model add one leading backslash; the parser removes exactly one. This count-preserving escape round-trips both a literal delimiter and an already escaped delimiter without changing inline tag mentions.

The executable contract lives in [the renderer, request assembler, parser, and response consumer](../../../../scripts/translation-prompt.ts). Unit tests cover both directions, request order, placeholder validation, target-path validation, strict section order and cardinality, fenced responses, inline tag mentions, delimiter lines inside Markdown bodies, and frontmatter-preserving new-pair switcher correction. A keyless subprocess snapshot pins the assembled prompt and five reviewed example turns together with a frontmatter-bearing recorded response consumed through the target-path correction.

## Alternatives considered

**Inject `translation-rules.md` into every request.** That document governs humans and agents as well as the automated pipeline. Injecting it couples each editorial clarification to model behavior and displaces the manually calibrated prompt constraints; the pipeline instead injects the binding terminology table and verifies its own asset directly.

**Use a strict CDATA XML document.** CDATA provides general XML framing but adds a nested protocol, an additional `]]>` escape, and XML-parser behavior that the three-section contract does not otherwise need. Reserving and escaping six delimiter lines keeps the calibrated response sections while preserving arbitrary Markdown.

**Return only the final translation.** A single body is simpler to parse but discards the explicit correction pass used to catch tone, structure, terminology, and punctuation defects before publication.

**Replace the calibrated v4 asset wholesale with a later experimental prompt.** Later experiments clarified useful general rules but did not pass strict whole-document evaluation as complete replacements. The production asset adopts only the improvements that preserve the established examples and executable protocol.

**Require a strict draft-to-final change ledger.** Requiring every final edit to appear in a free-text review ledger adds output burden without proving that the review catches local semantic drift. The review records actual corrections, while the final translation remains subject to deterministic structure checks and human review.

## Consequences

Prompt wording is executable behavior and receives code review, a translation-prompt verifier, and a runnable request/response snapshot. Focused tests pin the embedded examples and selected v7 safeguards. The `translation-prompt-v4` snapshot directory names the stable renderer/parser protocol series rather than the current calibration revision. The calibrated asset and the general translation rules can evolve for their different audiences, but review must reject contradictions with repository contracts. The line escape is visible only when source documentation contains a wrapper tag on its own line, and parser tests pin its lossless behavior.
