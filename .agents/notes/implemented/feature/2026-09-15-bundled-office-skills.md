# Agent Note: Bundled Office skills with structural verification

Status: implemented

English | [中文](2026-09-15-bundled-office-skills.zh.md)

## Problem

Office tasks need format-specific editing guidance and dependable file checks. Requiring users to install interpreters, package managers, or rendering command-line tools interrupts ordinary document delivery. Structural heuristics can also reject valid merged tables, multi-section documents, or Chinese text without observing an actual layout defect.

## Decision

The [Office provider](../../../../packages/skill/skill-office/README.md) contributes three independently discoverable skills at the bundled rank. The default workflow uses `load_workspace_dependencies` and its Python executable; explicit user and AGENTS.md environment choices take precedence. A configurable absolute asset root lets Desktop expose Python-readable resources outside its application archive. Registration validates the required resources and YAML descriptions; loaded instructions exclude the metadata. Disposal removes every candidate.

One standard-library checker recognizes Transitional and Strict OOXML namespaces, validates ZIP/XML integrity and internal relationships, reports format-specific structure, and checks only explicit text or count assertions. Corrupt or encrypted ZIP members produce the same JSON package-failure report as other invalid documents. DOCX table summaries count logical grid columns, including merged cells. Section geometry is reported rather than judged against the final section; font filenames do not establish glyph coverage. XLSX formula counts never imply recalculation. Text assertions follow section and note references and worksheet string indices, so retained headers, unused note definitions, comments, glossary entries, and unused strings cannot satisfy requested wording.

Desktop mounts the skill provider and runtime query independently of document rendering. Word uses python-docx, PowerPoint creation and editing use python-pptx, and Excel uses openpyxl and pandas. The managed payload and the ordinary creation examples require neither a rendering engine nor a separate presentation authoring library.

Office skills and the bundled-runtime query remain registered without a rendering service. Visual inspection depends on the active model accepting images and a rendering tool being available. Otherwise the skills complete structural and content checks and deliver with the unverified visual scope stated. `present` refers to the current workspace source file; it does not preserve a private copy.

## Alternatives considered

**Require a plan and a local renderer before every delivery.** Simple edits do not need a fixed planning artifact, and models without image input cannot judge rendered pages. Mandatory renderer installation would turn an optional quality signal into a dependency unrelated to many requests.

**Judge layout using package structure and font-name guesses.** Merged cells, different section widths, font substitution, and application layout rules prevent those observations from establishing rendered correctness. The checker reports facts and leaves visual judgments to actual images.

**Share one undifferentiated Office skill.** Format-specific discovery avoids loading spreadsheet formula guidance for a Word edit or presentation instructions for a cell update. The deterministic checker remains shared because all three formats use the same package relationship rules.

## Consequences

The provider supplies reusable instructions without selecting or installing a deployment runtime. The checker is portable wherever the supported Python standard library works, but it cannot establish Office rendering fidelity, advanced feature preservation, or formula results. Loader and disposal tests cover resource relocation, activation failures, and absent rendering services. A recorded Session pins the Office catalog and loaded instruction body. Checker tests cover structural failures and JSON diagnostics; native payload smoke executes the copied checker with the bundled interpreter.
