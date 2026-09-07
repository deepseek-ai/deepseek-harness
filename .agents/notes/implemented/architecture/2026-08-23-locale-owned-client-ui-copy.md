# Agent Note: Locale-owned client UI copy

Status: implemented

English | [中文](2026-08-23-locale-owned-client-ui-copy.zh.md)

## Problem

Typed locale namespaces and bilingual dictionary parity proved that registered dictionaries were complete, but they could not prove that presentation code used them. JSX text, accessibility attributes, formatter returns, and zero-Cordis primitive defaults could bypass `t` while every locale check remained green. The deferred and supposedly language-neutral exceptions recorded in the [initial full-rollout decision](../../archived/architecture/2026-07-30-client-locale-full-rollout.md) accumulated into a mixed-language UI, especially in trajectory inspection and generic Tool cards.

## Decision

**Locale dictionaries own all product-authored client UI wording.** Visible text, accessibility names, tooltips, placeholders, empty states, status labels, units, and formatting templates reach presentation through a typed `t` seat or an already-localized prop. A value authored by a user, model, provider, plugin, wire peer, or operating system remains data and renders verbatim; protocol tags, tool names, paths, URLs, JSON/JavaScript literals, and stable internal ids are not translated.

**Cordis-free primitives require complete localized copy props and own no language fallback.** `MarkdownText`, `JsonTree`, `TerminalBlock`, `DiffBlock`, `ReadBlock`, `SearchBlock`, `WebBlock`, `CodeBlock`, `JsonBlock`, `HoverCard`, and `ConnectionIndicator` receive their chrome from the feature render site. This preserves the primitive package's runtime independence while making omission a type error instead of silently selecting Chinese or English. Shared words live in the `common` namespace; feature-specific phrases stay with the feature that decides their meaning.

**Localized display text is never an identity.** Models and stores retain discriminants, stable ids, and non-display markers. Renderers translate after matching, and request maps carry stable group membership into the trajectory ledger. A client-synthesized error that must survive in a view model uses a stable marker and is translated only when displayed. Language switching therefore changes wording without changing selection, grouping, search identity, or lifecycle state.

**`verify-client-ui-i18n` enforces source ownership.** The TypeScript-AST check discovers every package `src/client` tree that contains TSX, all helper TS files under `packages/client/ui-*`, and the web app source. It rejects natural-language JSX text, copy-bearing attributes and component props, literal JSX branches, label/copy data, named copy helpers, string-returning display formatters, and destructuring defaults. Locale dictionary owners and immutable language tokens are the narrow syntactic exclusions. Discovery refuses a narrowed corpus, unit fixtures pin admitted and excluded forms, and the check runs in the static CI and `hygiene` graphs. Dictionary-key parity remains a separate check: one gate proves copy enters the locale path, while the other proves both shipped languages implement that path.

The product-authored error and design-literal exclusions, primitive defaults, and trajectory deferral in the [initial rollout](../../archived/architecture/2026-07-30-client-locale-full-rollout.md) are superseded by this decision. Its label-thunk, typed-seat, browser-locale, date-formatting, and search-placeholder decisions remain active.

## Verification

The AST check's own Vitest spec pins direct JSX, template branches, semantic copy props, label data, formatter returns, locale-key calls, structural attributes, and dictionary owners. Locale dictionary parity pins identical `zh`/`en` keys. Client component suites exercise both direct translated seats and locale-prop adapters, and the assembled web replay plus the required real-server GIF demonstrate the shipped locale switch on the actual trajectory surface.

## Alternatives considered

**Rely on review and AGENTS.md alone.** Rejected because the existing rule and typed dictionaries coexisted with hundreds of bypasses; reviewers need a source-level failure at the introducing line.

**Use a text regex or ban every string literal.** Rejected because TypeScript and JSX contain imports, CSS classes, discriminants, event names, SVG data, and user/wire values. Syntax-aware contexts provide useful signal without an ever-growing file allowlist, while the minimum discovery count prevents a falsely green narrowed scan.

**Keep primitive fallback copy for convenient direct use.** Rejected because a fallback is itself an implicit locale choice. Required label props keep primitives framework-free and make each product render site name its copy owner.

**Translate every string that reaches the DOM.** Rejected because authored data and protocol/code tokens are not product wording. Translating them corrupts evidence, identifiers, commands, paths, URLs, and provider diagnostics; only surrounding product chrome belongs to the locale system.

## Consequences

- Adding or changing client UI copy requires a typed dictionary key in both locales and behavior evidence for the affected render path.
- Pure primitives have larger explicit prop types, and tests provide deliberate label fixtures; this cost prevents hidden locale behavior.
- The AST check catches authored literal bypasses but cannot prove that an arbitrary dynamic string prop was translated. Types, dictionary parity, component tests, and review still own that semantic distinction.
- Boot markup that renders before the locale service and externally authored runtime data remain outside the dictionary path; product UI replaces boot copy after locale activation.
