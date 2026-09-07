# Agent Note: Web client syntax highlighting — synchronous fine-grained shiki

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-web-syntax-highlighting-shiki.zh.md)

> Scope: the web client's one syntax-highlighting system — the dependency ruling, the singleton shape, the token-sheet contract, and the consuming surfaces. Fifth PR of the PTC mode UI stack; the [chat sub-call rows note](../feature/2026-07-26-ptc-chat-subcall-rows.md) shipped the `run_code` program body this exists to make readable. Styling ground rules are owned by [the web styling ruling](2026-07-19-web-styling-system.md).

## Problem

The client rendered every code surface — markdown fences in assistant prose, the `run_code` program body, the details panel's args — as flat monospace text. The stack's primary payload is model-written TypeScript; unhighlighted programs are measurably harder to scan, and the repo already ships shiki-highlighted code on its VitePress site, so the web app was the one code-rendering surface without it.

## Decision

**Shiki in its synchronous fine-grained form, as one `ui-primitives` singleton, themed exclusively through CSS custom properties.**

- **Dependency**: `shiki/core` + `@shikijs/langs`, composed via `createHighlighterCoreSync` with `createJavaScriptRegexEngine({ forgiving: true })` — no oniguruma WASM, no async init, bundle-friendly. Grammar allowlist: `typescript` (embeds JS), `shellscript`, `json` — the languages the harness actually renders; everything else falls back to a geometry-identical plain block, never an error. Prior art: the VitePress site already renders all documentation code through shiki, and TextMate grammars materially beat regex highlighters on TypeScript — the payload that matters here.
- **Singleton**: `ui-primitives/src/markdown/highlight.ts` creates one `HighlighterCore` per document and exposes `highlightToHtml(code, lang)` (undefined = render plain). Engine + grammar construction is a ~120-175ms long task, so the module pre-warms the singleton in a deferred task at plugin boot (the lazy path stays as the correctness fallback), keeping the cost off the render path where a stream's finalize swap would jank. The alias table is a `Map`, not an object: fence info strings are assistant-authored, so a label like `constructor` must miss instead of resolving an inherited property and crashing shiki. The shared `CodeBlock` component owns both arms; its shiki arm injects the generated span tree via `dangerouslySetInnerHTML` — sanctioned because shiki emits a static span tree computed from the code text (no user HTML passes through, no scripts/handlers), shiki's own documented consumption path.
- **Theming**: shiki's `createCssVariablesTheme` routes every token color through `--shiki-*` custom properties; the VALUES live in `ui-theme/styles/shiki.css` (light on `:root`, dark on `body[data-ds-dark-theme]` — the same cascade as every other sheet), imported by ui-theme's dynamic client entry and compiled into its plugin-owned global CSS. Component CSS stays tokens-only; no literal color ever enters JS or component sheets. Background/foreground alias the existing markdown code-block tokens so highlighted and plain blocks agree.
- **Surfaces**: markdown fences (`MarkdownText`'s `pre` component routes single-string fences through `CodeBlock`), the `run_code` expanded program body (ToolRow's code variant, `lang="typescript"`), and the details panel's Input args (`lang="json"`). Tool output is never syntax-highlighted — it is arbitrary text, and guessing a grammar would mis-highlight more than it helps; a bash card's output carries only the color its own ANSI sequences declare, through [the terminal card](../feature/2026-07-28-web-terminal-card.md).

## Alternatives considered

**`rehype-highlight`/lowlight.** Runner-up: naturally sync and ~⅓ the bundle, but regex-grammar fidelity on TypeScript is visibly worse, and the repo would then run two highlighter systems (site: shiki, app: highlight.js) with two theming vocabularies.

**Full `shiki` bundle or the oniguruma WASM engine.** Rejected: the full bundle ships every grammar/theme; WASM needs async loading the sync client boot deliberately avoids. The fine-grained core with three grammars keeps the cost proportional to actual use.

**Highlight in a worker / async.** Rejected: the payloads are small (programs, fences, args); the synchronous JS engine tokenizes them in microseconds, and async introduces a flash-of-unhighlighted-code plus render-machinery churn for no measured need.

## Consequences

One code surface for every consumer — a future surface imports `CodeBlock` and inherits highlighting, theming, and the plain fallback. The bundle grows by the shiki core + three grammars (paid once in `ui-primitives`). Token colors are the first `--shiki-*` sheet; a theme package registering alias overrides extends them like any other token. jsdom specs pin the token-span structure, alias resolution, both fallback arms, and the fence route; the existing built-bundle snapshot and browser e2e cover the assembled path.
