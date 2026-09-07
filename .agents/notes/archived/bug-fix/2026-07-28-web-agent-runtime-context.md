# Agent Note: Web agents receive explicit runtime context

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-web-agent-runtime-context.zh.md)

## Problem

The shared CLI base configured an empty deployment persona, the Web overlay did not replace it, and the Web launcher added no source or interaction-surface section. A session header recorded its working directory for tools and persistence, but the model prompt did not state that directory or identify the DeepSeek Harness Web GUI. A request such as “change this page's theme” therefore made the agent search the selected project for an unspecified page, even when the user meant the GUI running the session.

## Decision

The Web profile composes the `dsh-base` and `dsh-web-app` bundles. The Web bundle supplies a concise coding-agent persona containing the resolved `{{model}}` and session `{{cwd}}`; its `web-runtime` plugin adds the `app:web-surface` section when `surfaceContext` is true. Before mounting the profile tree, the `dsh web` alias reads that same composed setting and installs the existing `harness:source` section only when the surface context is enabled. The headless bundle and a profile that owns its complete prompt set `surfaceContext: false`, suppressing the Web prompt and managed shell facts; the Web alias also suppresses the source section without checking an overlay path. Every mounted prompt contribution still activates before consumers such as the agent loop can emit a request header. The [source-checkout/workdir decision](2026-07-30-source-checkout-workdir-distinction.md) owns the source section's wording and its warning not to infer one path from the other.

The Web section treats unqualified references to “this page,” “this GUI,” or “this app” as references to the DeepSeek Harness Web GUI. It also states that the browser provides no implicit DOM, route, or screenshot context, so the model can identify the product without claiming visual state it did not receive. The assembled text is logged in `request/header`, preserving the model-visible/logged invariant.

## Verification

The Web runtime unit tests pin both enabled and disabled `surfaceContext` behavior, while the Web alias unit test pins default-on and explicit-off source-section gating from the composed row. The keyless fresh-round-trip Web scenario boots the shipped base plus Web bundle, runs a real session through the HTTP/SSE application, and snapshots the system-prompt prefix with source and working-directory paths normalized. The snapshot pins the harness identity, source checkout, Web orientation, and resolved coding-agent persona in request order. The Core Web snapshot applies the RL overlay and pins its complete system prompt with no source or Web section.

## Alternatives considered

**Send URL, DOM, or screenshots with every prompt.** The observed failure needed stable product orientation, while the current root URL does not identify a selected component and no visual capture exists in the message contract. Adding dynamic page state would require a separate logged model-input design and is not implied by this fix.

**Require the session Workspace to be the harness checkout.** Workspace cwd is the user's task target and may legitimately be an empty project or another repository. Conflating it with the application's source location would break that boundary and leave installed or externally launched sessions ambiguous.

**Put Web wording in the global harness identity.** `dsh-system-prompt` serves TUI, ACP, SDK, and custom deployments that do not run in a browser. The composing Web app owns this surface fact.

**Change the existing source-location section for every CLI surface.** The source section is shared with TUI and states only the checkout fact. Keeping Web orientation separate preserves that reusable contract and avoids telling headless or terminal agents that they are in a browser.

## Consequences

Ordinary Web requests gain a short stable prompt prefix and may invalidate provider prefix caches once when this change is deployed. Agents can distinguish the GUI source checkout from the selected Workspace and resolve ordinary references to the current app without a clarification round trip. References to a specific visual state remain bounded by the explicit no-DOM/no-route/no-screenshot statement and may still require a path, description, or attachment. Complete-prompt profiles can opt out through the Web runtime's composition setting without a launcher path check.
