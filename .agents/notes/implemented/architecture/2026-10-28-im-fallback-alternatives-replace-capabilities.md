# Agent Note: `<fallback>` alternatives replaced the IM capability layer

Status: implemented

English | [中文](2026-10-28-im-fallback-alternatives-replace-capabilities.zh.md)

## Problem

The vendored IM runtime answered "can this platform do X in this chat" before doing it. `plugin-im-core` owned a capability layer — `ChatFacts`, a per-bot `FactCache`, `LearnedFact`, `Support`, the `element.*` / `message.*` / `limit.*` key vocabulary, `evaluateCapabilities` and `mergeCapabilities` — that every adapter fed from three sides: a mode's declared operations, the adapter hooks, and a per-chat probe. The Lark adapter added a `getChat` probe plus five learned facts, and the QQ adapter published passive-reply windows through the same channel.

Every consumer then had to branch on the answer. `@deepseek-ai/dsh-experimental-im` exposed `caps` on the message event, on the service and on each turn's output IO; the summary and trace renderers asked five or six keys before deciding what to publish; a stop button existed only where `element.button.action` and `interaction.button` both answered `native`. The layer was also wrong in both directions: `unknown` had to mean "attempt it" for operations and "do not render it" for elements, so a probe that could not read a chat silently downgraded work, and a probe that answered `unknown` made the pipeline learn the same thing again from the failure. Nothing about a chat is knowable before the platform answers.

## Decision

The capability layer is deleted, not deprecated, and content itself carries the alternatives.

`@deepseek-ai/satori-element` gains the `<fallback>` element: each direct child is one ranked candidate, and a JSX fragment counts as one candidate, so `<fallback><title>…</title><h3>…</h3><text>…</text></fallback>` names three spellings of one message. `normalize` rewrites each candidate into an internal `<case>` normalized as content of the element the `<fallback>` stands in, which lets a fallback of phrasing content join the surrounding inline run. `RenderEngine` renders the first candidate whose whole subtree its registry renders natively — tag registered, variants declared, structural children standing — and otherwise the last candidate with the usual lowering; a nested fallback counts as native when one of its own candidates is. The choice lands in `RenderReport.fallbacks` and `degradationScore` charges a later candidate, so a mode that renders the author's first choice wins the per-publication mode resolution. Nothing in the engine consults per-chat state.

Removed with it: `capabilities.ts`, `Bot.supports` / `support` / `capabilities`, `Adapter.facts`, `Mode.operations`, `HandlerOptions.available`, `PlatformError.facts`, `RenderContext.caps` / `supports`, the Lark `facts.ts` chat probe and its learned facts, and the QQ passive-window facts. `LimitKey` moved to `mode.ts` and gained `limit.delete.window`; what a mode can do is now a registry fact (does it register the tag and declare the variant), an adapter-hook fact (`editPayload`, `deletePart`, `streamDriver`) or a declared limit. `Bot.edit` and `Bot.delete` decide from those, and a refusal is the classified `PlatformError` the platform answered — never a prediction.

`MessageStream.abort()` now reports whether a recall removed the published message, which is the one question a renderer cannot answer from its own content.

The IM consumers stop querying capabilities. `ImOutputIO`, `ImMessageEvent` and `ImApi` lost `caps`; the summary renderer resolves its plan from the strategy of the stream it opened (`patch` / `edit` publish provisional content, `final` / `append` do not) and writes its stop control as a `<fallback>` of an action button and a `reply /stop` line; the trace renderer writes each reasoning and tool item as a `<fallback>` of a collapsible panel and a one-line summary, and leaves the element budget to the mode that has one.

## Alternatives considered

**Keep the layer and add `<fallback>` beside it.** Two mechanisms would answer the same question and disagree: a renderer could ask whether a mode supports `<details>` while the mode's own registry is the only thing that decides it.

**Keep a small synchronous capability description for the consumers.** The renderers only need three answers (which stream strategy was opened, whether a recall succeeded, whether a button is actionable), and each of those is already reported by the event, the call, or the content itself. A description of "what this platform can do" would reintroduce the guessing that made the layer wrong.

**Probe the chat lazily and cache the answers per chat.** TTLs move the guess, they do not remove it: a mute, a whitelist refusal or an edit policy can change between two sends, and a stale `false` then blocks a working call.

## Consequences

A refusal costs one round trip and surfaces as an error, where the layer used to pre-empt it. Content that must degrade gracefully now says so in its own tree, which puts the decision in the renderer that knows what it is rendering rather than in a key table. Modes own their element budgets in `assemble` and `check`; the trace renderer no longer pre-folds panels. Adapters no longer cache anything about a chat, so a bot needs no probe, no TTL and no invalidation, and the QQ passive bookkeeping answers only the one question the stream driver asks (`remaining()`).

The corpus gained a `fallback` case, and conformance's text-conservation check ignores a `<fallback>`: which candidate renders is a property of the mode, so no single text is conserved. What was given up is any way to answer "can this chat do X" without trying, which the QQ and Lark `230075` paths previously used to choose a buffered stream up front; they now rely on the classified `limit` error to recall and resend.
