# Agent Note: Process-specific checkout path and Web URL move to runtime context

Status: implemented

English | [中文](2026-10-11-process-specific-prompt-values-in-runtime-context.zh.md)

## Problem

`dsh web` wrote two process-specific values directly into the system prompt: the implementation checkout path in the `harness:source` section (four directories above the web-app module) and the Web GUI URL in the `app:web-surface` section (the bound port or `publicUrl`). These operations change them without the user perceiving a system-prompt change:

| Operation | Changed value |
|---|---|
| Every Desktop launch (`--port 0` picks a random port) | Web URL |
| A different `--port`, or alternating A/B checkouts | Web URL, checkout path |
| npm and Desktop installations sharing one `DSH_HOME` | Checkout path |

On resume the loop renders the prompt again. On a route without `systemPromptUpdate: 'in-history'`, such as a hand-declared pi-ai `anthropic-messages` route, the changed prompt rewrites the surface head node. Claude binds historical thinking-block signatures to the conversation prefix, system prompt included, so the upstream answers 400 (`Invalid signature … bound to a different conversation`) and the Session cannot continue until the environment is restored. In-history routes do not fail, but every change appends a complete prompt.

## Decision

Both values become runtime context and the system prompt keeps only value-free guidance; a Session whose log already holds the earlier format keeps its logged paragraphs.

### Ownership

| Package | Responsibility |
|---|---|
| `@deepseek-ai/dsh-harness-dev-context` (`packages/context/harness-dev-context`) | Both sections, both contexts, and the earlier-format projection; all module-private, exporting only the plugin protocol (`name`, `inject`, `apply`) |
| `@deepseek-ai/dsh-host-webserver` | `WebServer.getOrigin()` (the bind address's URL form with protocol and bound port) and `bindUrlHost(host)` |
| `@deepseek-ai/dsh-web-app` | The `web-runtime` row provides `webApp`, whose `getAdvertisedUrl()` returns the configured `publicUrl`, otherwise the listener origin, the same value as `DSH_WEB_URL` and the startup URL; the bundle patch mounts the `harness-dev-context` row |
| `@deepseek-ai/dsh-system-prompt` | `CONTEXT_ORDERS.HARNESS_SOURCE = 200` and `WEB_SURFACE = 210` |

The plugin injects `systemPrompt`, `sessionProjections`, and `webApp` and reads those services in code; its patch row carries no configuration expression. The checkout path is four directories above this package's source or built entry, the same depth as the former web-app location, so source, npm, and Desktop installations resolve the same root. The URL is `webApp.getAdvertisedUrl()`, so a profile that overrides the `web-runtime` row's `publicUrl` reaches the model as well. The plugin reaches the `webApp` type through `import type {} from '@deepseek-ai/dsh-web-app'`; the import is erased at runtime, so the web-app bundle's dependency on this package remains the only runtime edge.

### New Sessions

| Registration | Content |
|---|---|
| Section `harness:source` (the `HARNESS_SOURCE` slot) | `The runtime context names the DeepSeek Harness implementation checkout. …`, the remaining guidance unchanged |
| Context `harness:source` (`CONTEXT_ORDERS.HARNESS_SOURCE = 200`) | `Current DeepSeek Harness implementation checkout: "<path>".` |
| Section `app:web-surface` (the `WEB_SURFACE` slot) | `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. …`, the remaining guidance unchanged |
| Context `app:web-surface` (`CONTEXT_ORDERS.WEB_SURFACE = 210`) | `Current DeepSeek Harness Web GUI URL: "<url>".` |

Both contexts are optional (no `required`). The only complete persona, web-app's minimal preset, also disables optional runtime context, so it still sees neither value. Runtime context follows the existing mechanism: an unchanged value emits no snapshot, a change appends a complete snapshot before the step's user message, and resume compares against the latest logged snapshot, never rewriting a committed message.

### Earlier-format Sessions

The plugin registers the host-only session projection `harnessDevLegacyPrompt`, folding every nonempty `system/message` in event order into `{ source, web }`: the paragraphs of that prompt that match an earlier template verbatim, or `null`.

| Earlier template | Matching rule |
|---|---|
| `harness:source` | Starts with `The DeepSeek Harness implementation checkout is at `, ends with the earlier fixed guidance, no line break between |
| `app:web-surface` | Starts with `You are interacting with the user through the DeepSeek Harness Web GUI at `, ends with `. ` plus the guidance as earlier releases rendered it, frozen as a literal, no line break between |

Both section text providers read the projection state of `AssembleContext.agent.session`: with an earlier paragraph they return it verbatim (`interpolate: false`), otherwise the current guidance. Diagnostic assemblies without an agent use the current guidance. `sessionProjections` is a required injection and the plugin registers its own unit, so the state is readable whenever an agent exists.

An earlier-format Session therefore satisfies both requirements:

| Scenario | System prompt | Runtime context |
|---|---|---|
| First resume after upgrading, same port | Byte-identical to the log; the loop emits no `system/message` | Appends a snapshot with both current values |
| Port, slot, or installation change after upgrading | Still the logged earlier paragraphs | Appends a snapshot with the new values |

The projection computes only on each committed `system/message`, adding no synchronous read of historical events; its state persists with projection checkpoints. When compaction or a new request series rewrites the head, the rendering still contains the same earlier paragraphs, so the projection state does not change.

## Alternatives considered

**Move both values to runtime context without keeping earlier paragraphs.** The upgrade itself changes the prompt text, so every existing Claude Session rewrites its head and fails with 400 on its first turn after the upgrade.

**Offer `supportsMidConvoSystemMessages` on hand-declared Anthropic routes.** The upstream accepts mid-conversation system messages in a live probe, but the pi-ai catalog already supplies that capability for named Anthropic routes and hand-declared routes withhold catalog fields by convention; in-history routes would still append a complete prompt on every value change.

**Ask the upstream to drop mismatched thinking blocks (`prefix_mismatch_behavior: "drop_block"`).** It silently loses historical reasoning and covers one vendor.

**Freeze the whole system prompt per Session.** Legitimate prompt changes such as plan mode, skills, and tool guidance would also be frozen and never reach the model.

**Keep the implementation in web-app and app-boot.** Development-facing context and earlier-format compatibility would enlarge the public API of two core packages; app-boot's `addHarnessSourceSection` had web-app as its only caller.

**Read `webStartup.publicUrl`.** It carries only the `--public-url` flag, so a profile override of the `web-runtime` row's `publicUrl` would reach `DSH_WEB_URL` but not the model; the effective value exists only inside web-app, which now provides it as `webApp`.

**Read the head node text from Session history directly.** The synchronous arbitrary-history read APIs are deprecated and new calls are prohibited; a projection is the established way to obtain that state after resume.

## Consequences

- A new Session's system prompt no longer changes with the port, slot, or installation; both current values arrive as runtime-context snapshots, and a change appends a few lines.
- An earlier-format Session keeps the old values of its earlier paragraphs for its whole lifetime; the later `Current …` runtime context in the same request gives the current values.
- Only these two paragraphs are protected. When other prompt text changes between releases, routes without in-history updates still rewrite the head.
- A release without this fix rewrites the head of a new-format Session with the earlier template on resume; both A/B checkouts need this fix before they alternate.
- app-boot no longer exports `addHarnessSourceSection` or `HARNESS_SOURCE_SECTION`; web-app's `surfaceContext` controls only `DSH_WEB_URL`, and disabling the `harness-dev-context` row turns both contexts off.
- Runtime context in recorded Web e2e Sessions gains two lines; the test scaffold normalizes the URL and checkout path to placeholders.

## Testing

- `packages/context/harness-dev-context/tests/harness-dev-context.spec.ts`: on a production AgentLoop, an earlier-format Session resumed on another port emits no `system/message`, the request's system prompt is byte-identical to the log, and runtime context carries the current URL; a second port change keeps this; replace-only and in-history routes each run. When a series consolidation only empties a later version, the next turn keeps the earlier paragraphs. Similar text without the fixed ending or broken across lines receives the current guidance. A new Session keeps its system prompt across a port change and only appends a runtime-context snapshot. Sections carry no values, the context carries the advertised URL, and disposing the plugin fiber removes every registration.
- `packages/host/webserver/tests/webserver.spec.ts`: `bindUrlHost` across address forms; `getOrigin()` on HTTP and HTTPS listeners, and its errors before binding and for a zoned non-loopback address.
- `packages/bundle/web-app/tests/web-app.spec.ts`: `webApp.getAdvertisedUrl()` returns the listener origin, or the row's configured `publicUrl`.
- `packages/core/system-prompt/tests/system-prompt.spec.ts`: the added context positions are unique integers.
