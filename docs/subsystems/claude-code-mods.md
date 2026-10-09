# Claude Code mods: compatibility

English | [中文](claude-code-mods.zh.md)

Every way a mod behaves differently through this bridge than under Claude Code, as of Claude Code 2.1.287 ([mods reference](https://code.claude.com/docs/en/plugins/mods/reference), its `claude-code.d.ts`) and the [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) post of 2026-10-01. A row names the Claude Code behavior, what this bridge does, and the reason or the follow-up. Anything not listed here behaves as the reference describes; a hook on an event this host never raises is named in a warning when the mod loads, and a `$` call outside the served table rejects with `no implementation for <namespace>.<method>`.

## Packaging and loading

| Claude Code | This bridge | Reason or follow-up |
|---|---|---|
| A plugin directory with `.claude-plugin/plugin.json` and `hooks/hooks.json` naming one hooks module; `claude --plugin-dir`, marketplaces, `/plugin install` | A mod is a plugin: `defineMod({ name, version, root, userConfig, register })` wraps the hooks module and mounts through cordis.yml after the bridge; `plugin.json` and `hooks.json` are not read | Mods join the one composition mechanism every DSH plugin uses; the example directories keep their manifests so they also run under `claude --plugin-dir` |
| `userConfig` schema in `plugin.json` with typed defaults; options validated at load | `userConfig` is the defaults object of the `defineMod` spec; the plugin's cordis.yml `config` overlays it and is validated as a record of strings, numbers, booleans, and string lists | No manifest is read |
| Tiers (`user`, `project`, `managed`) and `next.to(e, tier)` | Every mod loads as `user`; `tier()` in a test is accepted and ignored; `next.to` rejects | Managed settings are not a DSH concept |
| Hot reload of the hooks module on edit; `claude plugin validate`, `claude plugin test`, types generation from `types/index.d.ts` | None of these commands; a remount re-runs `register` on the same evaluated module, so module-level variables keep their values | Follow-up only on demand; the test kit's `createModTestKit` replaces `claude plugin test` inside Vitest |
| A hooks module may be TypeScript | A `.ts` hooks module loads only where the launcher transpiles (the source launch does; a built install does not) | DSH ships plain Node |
| Mods run in-process with `$` as their only access to the host | The hooks module runs in-process with Node's globals, no access rule, and the process's full authority: `$.env` reads and writes the harness environment, `$.http.fetch` reaches any URL, `$.fs` and `$.tool.call` act as the session | No sandbox is applied to mods; mount only mods you would run as a plugin |
| `import type { … } from 'claude-code'`, `declare module 'claude-code' { interface PluginState }` | The `claude-code` module name resolves only inside this repository's test setup, to the bridge's types; a mod outside it imports `@deepseek-ai/dsh-experimental-claude-code-mods` | The type names are the bridge's own |
| `settings hooks` in `hooks.json` run beside mod hooks | Not run; mount `@deepseek-ai/dsh-hooks-claude-code` for them | Different bridge |

## Events

| Event | Claude Code | This bridge |
|---|---|---|
| `session.start` | Raised once per session, before the first prompt | Raised for a root agent from `agent/created`, awaited before its first turn; not raised for subagents |
| `session.end` | Raised once per session | Raised for a root agent from `agent/disposed`; `$.state` is readable until the hooks settle |
| `prompt.submit` | `e.text` is the typed prompt; `context` entries become one block each after the prompt as typed; a prompt a plugin submitted carries `origin: { kind: 'plugin', name }` | Same; `e.text` joins the text blocks of the human's own (`user`-sourced) messages in the claimed batch, a batch of injected context alone raises nothing, and a prompt `$.prompt.submit` queued carries the submitting mod as its origin |
| `turn.start`, `turn.complete` | Per turn; subagent turns carry `agentId` | Same; `turn.complete`'s `{ text }` reaches the host log, not a line under the answer; `durationMs` counts from `turn/start` |
| `tool.call` | Runs before Claude Code's permission check; `next({ ...e, command })` rewrites the arguments the tool runs with, and `next({ ...e, tool })` reroutes the call | Runs around `tools/execute`, after the harness permission decision; a hook (or `.catch` handler) that rewrites arguments or names another tool is skipped with a report — the argument case names the [pre-tool input rewrite proposal](../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md) — because the logged call runs as logged. `{ deny }`, `{ result }`, observing, and rewriting the result or `isError` after `next` work as described |
| `command.run` | Runs for a command the mod registered | Same |
| `ui.render` | Raised for every render site (`AbovePrompt`, `Pane`, `ToolUse`, `AssistantMessage`, `Spinner`, …) | Raised for `AbovePrompt` only, once per redraw of a session's band; `Pane` hooks run only through the test kit's `$.ui.mount({ component: 'Pane' })` |
| `tool.check`, `tool.describe`, `tool.list`, `tool.register` | Shape the tool list and permissions | Not raised; `$.tool.register` and `$.tool.list` are served as `$` calls |
| `turn.step` | Per model step | Not raised |
| Every other reference event: the other `prompt.*` events, `skill.prompt`, `attribution.text`, `command.describe`, `config.*`, the other `session.*` events, `agent.*`, `plugin.register`, `engine.create`, `telemetry.*`, `ui.resolve`, `ui.press`, `ui.input`, `ui.select`, `ui.focus`, `ui.scroll`, `ui.close`, `ui.message` | Raised by the engine | Registered, never raised, named in a warning at load |
| `classic.*` | Classic settings hooks as events | Refused at `register`, like any unknown event name |
| `<namespace>.<method>` op events (`fs.read`, `store.set`, …) | A later-loaded mod's `$` call reaches the mods loaded before it | Same; `tool.call` arrives through the tool pipeline instead |

## The chain

| Claude Code | This bridge | Reason |
|---|---|---|
| A hook may call `next` more than once; each call runs the chain beneath again | `next` runs once: a second call returns the first run's result | One tool execution per logged call |
| A hook that answers while its `next` is still running | The run beneath is awaited before the hook's answer settles; a failure beneath after the answer is reported | The event settles only when nothing it started is running |
| 10 s own-time budget, 1 s for `.catch`, time inside `next` and `$` calls excluded except `$.clock.sleep` | Same, configurable (`hookTimeoutMs`, `catchTimeoutMs`) | — |
| Not returning a result object is a failure | Same; `null` is accepted as an answer (a surface drawn empty) | `ui.render` with nothing to draw |
| A result's unknown fields are dropped and wrong types fail the hook | A `prompt.submit` result with wrong types keeps the original text and only the string context lines | Lenient on the one event where partial results are common |

## `$` members

| Namespace | Claude Code | This bridge |
|---|---|---|
| `$.plugin` | `name`, `root`, `tier` | `name`, `root` from the `defineMod` spec |
| `$.ui` | `resolve`, `invalidate`, `open`, `close`, `panes`, `focus`, `log`, `toast`, `status`, `notice`, `ask`, `blit`, `copy`, `press`, `input`, `select` | `resolve`, `invalidate`, `open`, `close`, `panes`, `log`, `toast`, `status`, `ask`; `open` answers `{ isPlaced: false }` with a reason and redraws the band; `log`, `toast`, `status` reach the host log; the rest reject |
| `$.command` | `register`, `run`, `list` | Same; `run` of a command nobody answers rejects with the registering mod named |
| `$.tool` | `register`, `call`, `list` | Same; a registered tool is `mcp__<plugin>__<tool>`; `call` runs the harness pipeline and injects a tool's deferred contexts into the session |
| `$.prompt` | `submit`, `compose` | `submit`; the message is `user`-sourced, framed `Message from the "<plugin>" mod:` unless `asUser`, and the `prompt.submit` it raises names the mod as origin |
| `$.session` | `id`, `cwd`, `root`, `repo`, `model`, `turns`, `messages`, `usage`, `version`, `send`, `append`, `authorize`, `compact`, `surfaces` | `id`, `cwd`, `root`, `model`, `turns`, `messages`, `usage`, `version`; `cwd` reports the committed current directory; `root` retains the original project; `usage.context.window` is `0` and `percent` absent until the token meter knows the route's window; `rateLimits` is empty; `version` names this bridge |
| `$.state` | Per session, survives hot reload | Per session, in memory; a read during `ui.render` subscribes the band to the slot |
| `$.store` | Per plugin, durable | Same, in the `claude_code_mods` storage domain, 4 MiB per plugin |
| `$.clock` | `now`, `sleep`, `after`, `every`; timers die with the plugin | Same; a timer also dies with the session whose event scheduled it, and `sleep` rejects when the event is cancelled |
| `$.fs` | `read`, `write`, `list`, `exists`, `stat`, `ancestors` | All but `ancestors`; 4 MiB per file; `stat.mtimeMs` is `0` |
| `$.process` | `run`, `spawn` | `run` only, argv without a shell, `processTimeoutMs` default |
| `$.http` | `fetch` | Same, bodies up to 4 MiB |
| `$.env` | `get`, `set` | Same; the process environment is shared by every session and plugin |
| `$.model`, `$.agent`, `$.config`, `$.settings`, `$.mcp`, `$.audio`, `$.telemetry`, `$.turn` | Served | Reject with `no implementation`; `$.model.complete` waits on a logged side-request event |

## Drawing

| Claude Code | This bridge |
|---|---|
| `Box`, `Text`, `Button`, `Input`, `Spacer`, and the host's own element kinds | `Box`, `Text`, `Button` from `$.ui.resolve(e)`; the tree is validated, and a `Button`'s `onPress` stays in the host behind a per-drawing action id |
| `Box` props: `flexDirection`, `padding*`, `gap`, `border*`, `width`, `height`, `overflow`, `scroll` | `flexDirection`, `padding`, `paddingX`, `paddingY`, `gap`, `border`, `borderColor`; the others serialize and the Web band ignores them |
| `Text` props: `color`, `bold`, `dimColor`, `italic`, `underline`, `wrap`, `truncate` | `color` (the terminal palette names), `bold`, `dimColor`, `italic`, `underline`; the Web band wraps |
| `Button` props: `label`, `hotkey`, `disabled`, `onPress`; a bare digit arms the hotkey | `label`, `hotkey` (shown as a hint), `disabled`, `onPress` (a click) |
| The band is one instance; `hasSurvey`, `isWorking`, `maxRows`, `bodyColumns` reflect the terminal | One instance per session, consulted in mod load order; `bodyColumns` and `viewport.columns` are the bridge's `bandColumns` (default `120`), `maxRows` its `bandRows` (default `10`), `hasSurvey` and `isWorking` are `false`; the Web band wraps instead of scrolling |
| The band redraws on the host's frame and when a `$.state` value a render read changes | Redraws after `session.start`, when a `$.state` value the last drawing read is written, after `$.ui.open`, `$.ui.close`, `$.ui.invalidate`, after each `tool.call` chain and `turn.complete` settle, and after a press; a mod that changes module-level state at other times draws it at the next trigger. A press runs `onPress` without a time limit |
| `Pane` with `focus`, `scroll`, docked beside the transcript | No pane: `$.ui.open` answers `{ isPlaced: false }` so a mod falls back to the band; the test kit mounts `Pane` hooks directly |
| Hotkeys, `TextInput`, focus, scrolling, `ui.press`, `ui.input`, `ui.select` | Not served; follow-up |

## Testing

| `claude-code/testing` | This bridge |
|---|---|
| `describe`, `test(name, ($, on) => …)`, `expect`, `mock`, `tier` | Inside this repository the same module name provides them over Vitest; `test` infers the mod from the test file's location (`<mod>/tests/*.test.ts` → `<mod>/index.ts`) and `defineModTests` overrides it. Outside, `createModTestKit` and `mock` come from `@deepseek-ai/dsh-experimental-claude-code-mods/testing` |
| `on` stubs the engine's answers; the kit answers `ui.*` itself | Same; `ui.open` answers `{ isPlaced: false }`, `ui.invalidate` and `ui.close` succeed; `session.cwd`, `process.run`, `fs.*`, `store.*`, `env.*` need a stub (`mock.store`, `mock.env`, `mock.clock` answer whole namespaces) |
| `$.ui.mount({ plugin, surface, component, props })` → `find`, `findAll`, `press`, `unmount` | Same, plus `tree()` and `text()`; every read renders afresh through every loaded mod's hooks; `plugin` and `surface` are accepted for source compatibility |
| 5 s hook budget in tests | Same (`budgetMs`) |

## The example mods

| Mod | Source | Through this bridge |
|---|---|---|
| Token Weather | The post's module, type contract, and test, unchanged | Runs as published; the test's three `as any` casts are dropped because the kit is typed. Draws in the band from `$.session.usage` through the token meter |
| Blast Radius | The post's `tool.call` hook unchanged; `classify`, `measure`, and the trees completed to the post's description | Holds the command with real `sleep` polls, draws the report in the band (`isPlaced: false`), and Proceed or Cancel decides; load it before Token Weather |
| Replay Theater | The post's five hooks unchanged; `stepsFor`, the diff, `openReplay`, the pane and the hint completed | Records Edit and Write calls, hints in the band after the turn, and steps through the diffs in the band because no pane is placed |
| `diff` ([anthropics/claude-code](https://github.com/anthropics/claude-code/tree/main/mods/diff), read at `52c7644`) | TypeScript, ~570 files, hooks `command.run`, `prompt.submit`, `session.start`, `tool.call`, `ui.close`, `ui.focus`, `ui.render`, `ui.scroll` | Not runnable: needs `$.settings.read`, `$.telemetry.*`, `$.session.messages` over a pane, `ui.focus` and `ui.scroll` events, and a placed `Pane`. Assessed by reading; the repository's terms do not allow a fixture copy |
| `agents-md` (same repository) | Hooks `agent.spawn`, `prompt.context`, `session.start`, `tool.call` | Not runnable: `prompt.context` and `agent.spawn` are not raised and `$.fs.ancestors`, `$.telemetry.*` are not served |
| `sec-default` (same repository) | Hooks `tool.check`, `prompt.compose`, `settings.read`, `classic.*`, `plugin.register`, … | Not runnable: managed-tier policy over events this host does not raise |
| `telemetry` (same repository) | Hooks `engine.create`, `telemetry.*`, `session.start`, `session.end`; calls `$.session.repo`, `$.settings.read` | Not runnable: `telemetry.*` and `engine.create` are not raised and the two `$` members are not served |

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclaudecodemods--claudecodemods"></a>

### `ctx.claudeCodeMods` — `ClaudeCodeMods`

The bridge service: loaded mods, their hooks, and the harness listeners that raise their events. Mods join through ClaudeCodeMods.add, which defineMod calls when a mod plugin mounts. The Remote methods let a Client draw each session's band above the prompt and press its buttons.

```ts cordis-catalog
/**
 * Watch the band above the prompt of one session: the current drawing, then
 * every redraw, until the Client stops watching.
 * @param agent - the session's agent, resolved by the Gateway.
 * @param signal - carrier cancellation.
 * @returns the band's snapshots.
 */
@Remote({ mode: 'stream' }) watchBand(agent: Agent, signal: AbortSignal): AsyncIterable<SurfaceSnapshot>

/**
 * Press a button of the band's current drawing: runs the mod's `onPress` and redraws.
 * @param agent - the session's agent, resolved by the Gateway.
 * @param generation - the drawing the Client saw.
 * @param actionId - the button's action id in that drawing.
 * @returns the snapshot after the press.
 */
@Remote pressBand(agent: Agent, generation: number, actionId: string): Promise<SurfaceSnapshot>

/**
 * Load one mod beneath every mod loaded before it: run its `register`,
 * keep its hooks, and report which of its events this host never raises.
 * @param definition - the mod as its plugin defined it.
 * @returns the disposer that removes the mod's hooks, closes its timers, and releases its registrations.
 * @throws Error when the name is invalid or taken, or when `register` throws (Claude Code's `hooks module did not load` wording).
 */
async add(definition: ModDefinition): Promise<() => Promise<void>>
```

Types: [Agent](core.md)

Source: [`packages/experimental/claude-code-mods/src/index.ts`](../../packages/experimental/claude-code-mods/src/index.ts)
<!-- END GENERATED cordis-surface -->
