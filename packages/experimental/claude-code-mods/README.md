---
description: "Experimental bridge that runs Claude Code mods as DSH plugins: their register(on, options) hooks guard tool calls, rewrite prompts, add commands and tools, and draw above the prompt, for users mounting a mod and maintainers extending the mapping."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-claude-code-mods

English | [中文](README.zh.md)

## Summary

Run [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) inside agent runs: wrap a mod's `register(on, options)` with `defineMod`, mount it as a plugin after this bridge, and its hooks guard tool calls, rewrite prompts, add commands and tools, read session facts, and draw a band above the prompt through the same `$`, `e`, `next` chain. Mounting costs nothing until a mod acts; each `$` call rides a composed harness service. It is an alpha interface-compatibility demonstration: an unserved event is reported at load, an unserved `$` member fails naming the gap, and [the compatibility page](../../../docs/subsystems/claude-code-mods.md) lists every difference.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A mod is a plugin. `defineMod` takes the mod's `register` function with the identity `plugin.json` would hold and returns a Cordis plugin whose config is the `options` object `register` receives, overlaid on the `userConfig` defaults you name. Mount the bridge first, then the mods in chain order.

```ts
// mods/token-weather/index.ts — `register` is the mod's own hooks module (`./hooks/token-weather.mjs`).
import { defineMod, type ModOn } from '@deepseek-ai/dsh-experimental-claude-code-mods'

declare const register: (on: ModOn, options: Readonly<Record<string, unknown>>) => void

export default defineMod({ name: 'token-weather', version: '0.1.0', root: import.meta.dirname, register })
```

```yaml
- name: '@deepseek-ai/dsh-experimental-claude-code-mods'
- name: './mods/blast-radius/index.ts'
- name: './mods/token-weather/index.ts'
  config:
    history: 12
```

| Bridge field | Default | Meaning |
|---|---|---|
| `hookTimeoutMs` | `10000` | A hook's own running time per event (Claude Code's limit); time inside `next` or a `$` call does not count |
| `catchTimeoutMs` | `1000` | A `.catch` handler's running time |
| `processTimeoutMs` | `30000` | Default `$.process.run` and `$.http.fetch` timeout |
| `toolAliases` | — | Claude Code tool name → harness tool name entries added to the built-in table |
| `bandColumns` | `120` | Columns the band above the prompt reports to `ui.render` as `bodyColumns` and `viewport.columns` |
| `bandRows` | `10` | Rows the band reports as `maxRows` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-claude-code-mods) is the exhaustive source for every accepted field. The [examples](examples/) directory holds the three mods from Anthropic's [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) post as plugin directories that also run under `claude --plugin-dir`: Token Weather with its published module, types, and test unchanged, and Blast Radius and Replay Theater completed from the published fragments. The [opt-in overlay](cordis.source.patch.yml) composes the bridge, the three mods, and the [Web band](../client-ui-claude-code-mods/README.md) for a source launch.

### Which events your mod receives

| Event | Raised from | A hook can |
|---|---|---|
| `session.start` | `agent/created` of a root agent, awaited before its first turn; cancelling the creation abandons a waiting hook | observe; register commands and tools |
| `prompt.submit` | `agent/pre-step` with claimed messages; `e.text` joins the text blocks of the human's own (`user`-sourced) messages, and a rewrite touches only those | rewrite `text`, add `context` blocks after the prompt as typed, or `{ drop }` the prompt |
| `turn.start` | the first `agent/pre-step` of a turn | observe |
| `tool.call` | the `tools/execute` waterfall, after the harness permission decision; a call a mod raised with `$.tool.call` reaches only the mods loaded before it, attributed to the caller | observe before and after, `{ deny }`, answer with `{ result }`, or rewrite the result or its `isError` after `next` |
| `turn.complete` | the `turn/end` session event | observe; return `{ text }` for a line in the host log |
| `command.run` | a command the mod registered with `$.command.register` is typed | answer with `{ text }` or `{}` |
| `ui.render` | the band above the prompt redraws: `{ component: 'AbovePrompt' }` with `bodyColumns`, `hasSurvey`, `isWorking`, `maxRows` props | return a `Box`/`Text`/`Button` tree from `$.ui.resolve(e)`, or `next(e)` to yield the band |
| `session.end` | `agent/disposed` of a root agent; `$.state` stays readable until the hooks settle | observe |
| `<namespace>.<method>` | a later-loaded mod's `$` call (`tool.call` arrives through the tool pipeline instead) | observe, rewrite, or `{ deny }` it |

`e.tool` and `tool` matchers use Claude Code's names where a harness tool has one (`Bash` ↔ `bash`, `Read` ↔ `read`, `Edit` ↔ `edit`, `Write` ↔ `write`, `Glob` ↔ `glob`, `Grep` ↔ `grep`, `WebFetch` ↔ `web_fetch`, `WebSearch` ↔ `web_search`, `Task` ↔ `subagent`, `TodoWrite` ↔ `todo_write`, `AskUserQuestion` ↔ `ask_user_question`, `ExitPlanMode` ↔ `exit_plan_mode`, `Skill` ↔ `skill`); every other tool keeps its harness name. Subagent events carry `e.agentId`. Every other Claude Code event name registers without error, never fires, and is named in a warning when the mod loads.

<a id="the-band-above-the-prompt"></a>
### The band above the prompt

The band is one instance per session, drawn by the first mod in load order whose `ui.render` hook returns a tree; a hook that calls `next(e)` yields to the next mod, so put a mod that draws only while it holds something (Blast Radius, Replay Theater) before one that draws whenever it has a reading (Token Weather). The band redraws after `session.start`, when a `$.state` value the last drawing read is written, after `$.ui.open`, `$.ui.close`, and `$.ui.invalidate`, after each `tool.call` chain and `turn.complete` settle, and after a button press. A `Button`'s `onPress` stays in the host; the Web band sends a click back with the generation it saw, and a click on an earlier drawing is reported and ignored. `$.ui.open` answers `{ isPlaced: false }`: no pane is placed, and a mod that degrades to the band draws there. The [test kit](#test-a-mod)'s `$.ui.mount` renders the same hooks without a Client.

### Which `$` members your mod can call

| Namespace | Served | Over |
|---|---|---|
| `$.plugin` | `name`, `root` | the `defineMod` spec |
| `$.ui` | `resolve`, `invalidate`, `open`, `close`, `panes`, `log`, `toast`, `status`, `ask` | `resolve` hands out the element constructors; `invalidate`, `open`, `close` redraw the band; `ask` on `ctx.userQuestions`; `log`, `toast`, `status` reach the host log |
| `$.command` | `register`, `run`, `list` | `ctx.commands`, scoped to the agent whose event is running |
| `$.tool` | `register`, `call`, `list` | `ctx.tools`; a registered tool is named `mcp__<plugin>__<tool>`; contexts a tool defers to the next request are injected into the session |
| `$.prompt` | `submit` | `agent.followup()` as a `user`-sourced message, framed as a message from the mod unless `asUser`; the `prompt.submit` it raises carries `origin: { kind: 'plugin', name }` |
| `$.session` | `id`, `cwd`, `root`, `model`, `turns`, `messages`, `usage`, `version` | the agent's Session and the `turnBoundary` and `contextPressure` projections; `cwd` and `root` both report the session workspace, the harness's one directory per session |
| `$.state` | `get`, `set` | memory held for the session, addressed by the `{ plugin, key }` a mod names; a read during `ui.render` subscribes the band |
| `$.store` | `get`, `set`, `delete`, `keys` | the `claude_code_mods` storage domain, one JSON object per plugin, 4 MiB |
| `$.clock` | `now`, `sleep`, `after`, `every` | timers owned by the session whose event scheduled them; `sleep` rejects when the event is cancelled |
| `$.fs` | `read`, `write`, `list`, `exists`, `stat` | `ctx.fs`, relative to the session workspace, 4 MiB per file |
| `$.process` | `run` | `ctx.subprocess`, argv without a shell |
| `$.http` | `fetch` | the process's `fetch`, bodies up to 4 MiB |
| `$.env` | `get`, `set` | this process's environment, shared by every session and plugin |

A call whose service is not composed rejects with the missing service's package name; a namespace or method outside this table rejects with `no implementation for <namespace>.<method>`. A mod runs in this process with its full authority: `$.env` reads and writes the harness environment, `$.http.fetch` reaches any URL, `$.fs` and `$.tool.call` act as the session does.

<a id="test-a-mod"></a>
### Test a mod

`createModTestKit` from `@deepseek-ai/dsh-experimental-claude-code-mods/testing` loads `defineMod` plugins or bare definitions and raises events through them with stubs beneath, in the shape of `claude-code/testing`: `kit.on('tool.call', () => ({ result: 'ok' }))` answers in the engine's place, `kit.$.tool.call({ tool: 'Bash', command: 'ls' })` raises the event, `kit.$.ui.mount({ component: 'AbovePrompt' })` renders the band and finds or presses its elements, and `mock.store(kit.on)` answers `$.store` from memory. Inside this repository, `claude-code/testing` resolves to the kit plus Vitest's `describe`, `test`, and `expect`, so the [example mods' tests](examples/token-weather/tests/token-weather.test.ts) run as written for `claude plugin test`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Loading

[`define-mod.ts`](src/define-mod.ts) turns a spec into a Cordis plugin that calls `ctx.claudeCodeMods.add(definition)` on mount and removes the mod on unmount. [`module.ts`](src/module.ts) runs `register` and collects each `on(...)` into a `HookRegistry`; `on` refuses an unknown event name and a second matcher-less registration of one event with Claude Code's wording, and a `register` that throws fails the mod plugin's mount. Mod order is mount order, so cordis.yml order is chain order.

### The chain

[`chain.ts`](src/chain.ts) runs one event through the selected hooks, outermost first, with the engine behavior at the bottom. Each hook's `next` delegates beneath once: a second call returns the first run, and a run a hook started is awaited before the hook's own answer settles. A hook that throws, times out, or settles without a result is skipped and reported once per failure kind, the result from beneath stands when it had already called `next`, and a `.catch` handler may answer in its place. The budget clock counts only the hook's own running time: it pauses inside `next` and inside every `$` call except `$.clock.sleep`. [`engine.ts`](src/engine.ts) owns the registry, per-session `$.state`, timers keyed by session and mod, and the two dispatch directions: an engine event reaches every selected hook, while a `$` call raised by one mod reaches only the mods loaded before it.

### Mapping onto the harness

[`index.ts`](src/index.ts) registers the listeners. `tool.call` runs around `tools/execute`, so the harness permission decision precedes the chain; a `{ deny }` becomes an error result with the reason, a `{ result }` becomes a successful result when the tool is mod-registered or the value satisfies the tool's output schema, and an error-shaped result otherwise. A result a hook rewrote after `next` is installed as replacement content through `tools/post-execute`. A hook that passes rewritten arguments to `next` is skipped with a report, because the call's arguments are already logged. [`host-ops.ts`](src/host-ops.ts) holds the engine behavior for each `$` call over `ctx.get(...)` services, so a deployment composes only what its mods use. [`surfaces.ts`](src/surfaces.ts) keeps one band per session: it raises `ui.render`, validates and serializes the tree with [`elements.ts`](src/elements.ts), holds each `Button`'s `onPress` behind a per-drawing action id, subscribes the band to the `$.state` slots the drawing read, and streams generations to the Client through the `claudeCodeMods` Remote (`watchBand`, `pressBand`).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The bridge service: config, mod registry, extension-point listeners, Remote |
| [`src/define-mod.ts`](src/define-mod.ts) | `defineMod`: a mod as a plugin |
| [`src/host-ops.ts`](src/host-ops.ts) | `$` behavior over harness services |
| [`src/surfaces.ts`](src/surfaces.ts), [`src/elements.ts`](src/elements.ts) | The band above the prompt; element constructors, validation, serialization |
| [`src/engine.ts`](src/engine.ts) | Registry, `$.state`, timers, dispatch directions |
| [`src/chain.ts`](src/chain.ts) | Middleware chain, budget clock, failure rules |
| [`src/api.ts`](src/api.ts) | The `$` object a hook receives |
| [`src/module.ts`](src/module.ts), [`src/matcher.ts`](src/matcher.ts), [`src/tool-names.ts`](src/tool-names.ts) | `register` and `on`; event names, matchers, tool-name aliases |
| [`src/testing.ts`](src/testing.ts) | The test kit (`./testing`) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Compatibility with Claude Code mods](../../../docs/subsystems/claude-code-mods.md) — every way this bridge differs from Claude Code mods, with the fix or the reason.
- [Claude Code mods reference](https://code.claude.com/docs/en/plugins/mods/reference) — the events, methods, and limits this bridge mirrors.
- [The Web band](../client-ui-claude-code-mods/README.md) — the Client package that draws `ui.render` trees in the input dock.
- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [Hooks group](../../hooks/README.md) — the settings-hook bridges; a plugin's `hooks.json` settings hooks need `dsh-hooks-claude-code`.
- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — the waterfalls `tool.call` runs around.
- [Human commands](../../interaction/commands/README.md) — the registry `$.command.register` lands on.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt context and submitted prompts

#### What the model sees

Strings a `prompt.submit` hook adds to `e.context` become text blocks after the prompt as typed, inside the human's own message; a rewritten `text` replaces the prompt's text blocks. `$.prompt.submit({ text })` queues a `user`-sourced message: the text alone with `asUser: true`, otherwise framed as below with the plugin name and the text filled in.

##### Framing of a prompt a mod submits

```markdown
Message from the "<plugin>" mod:
<text>
```

#### Token effect

No cost until a mod adds context or submits a prompt; that text is data-dependent, logged, and resent in later requests until compaction.

#### KV Cache effect

Append-only: added context and submitted prompts follow the reusable request prefix and do not invalidate existing entries.

### Tool outcomes a mod decides

#### What the model sees

A `{ deny: reason }` answer renders `Error: <reason>` as the tool result. A `{ result }` answer renders through the tool's own presenter when the tool is mod-registered or the value satisfies the tool's output schema, and as an error-shaped result carrying the text otherwise. A result rewritten after `next` replaces the tool's content text. A dropped prompt ends the turn as `blocked` with no model-visible message. A mod that holds a `tool.call` (Blast Radius) delays the result until a button decides; the model sees only the outcome.

#### Token effect

Denial and answered calls replace the tool's own output with the mod's text; a dropped prompt sends no request.

#### KV Cache effect

Tool results append after the reusable prefix; a dropped prompt invalidates nothing.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe where a Claude Code mod behaves differently through this bridge; [the compatibility page](../../../docs/subsystems/claude-code-mods.md) is the complete list. They are current package constraints, not a task backlog.

- **One drawing surface** — `AbovePrompt` is served; `Pane`, the other render sites, `Input`, hotkeys, `ui.press`, `ui.input`, `ui.select`, `ui.focus`, and `ui.scroll` are not: `$.ui.open` answers `{ isPlaced: false }`, and `$.ui.log`, `$.ui.toast`, and `$.ui.status` reach the host log, not the GUI. A hook draws for a band `bandColumns` wide; the Web band wraps. A button's `onPress` runs without a time limit; a hanging one keeps the band's buttons disabled until it settles.
- **`next` runs once** — a hook that calls `next` twice gets the first run; Claude Code runs the chain beneath again. A hook that answers while its `next` is still running waits for that run.
- **Unserved events** — `tool.check`, `tool.describe`, `turn.step`, the other `prompt.*` events, `command.describe`, `config.*`, `session.compact`, `session.receive`, `session.send`, `session.append`, `session.attach`, `session.detach`, `session.measure`, `agent.*`, `plugin.register`, `engine.create`, and `telemetry.*` register, never fire, and are named in a warning at load; `classic.*` names are refused at `register` like any unknown event.
- **Unserved `$` namespaces** — `$.model`, `$.agent`, `$.config`, `$.settings`, `$.mcp`, `$.audio`, `$.telemetry`, `$.turn`, `$.ui.notice`, `$.ui.blit`, `$.ui.copy`, `$.fs.ancestors`, `$.process.spawn`, and `$.session.repo`, `send`, `append`, `authorize`, `compact`, `surfaces` reject with `no implementation`. `$.model.complete` waits on a logged side-request event so a mod's model call stays reconstructable from the Session log.
- **`tool.call` runs after the permission decision** — Claude Code runs mod `tool.call` hooks before its permission check; here the harness `tools/pre-execute` waterfall, including approval, settles first. A hook that rewrites the arguments it passes to `next`, or names another tool, is skipped with a report (the argument case names the [pre-tool input rewrite proposal](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)), because the logged call runs as logged.
- **One process, many sessions** — a mod's module-level variables and `$.env.set` writes are shared by every session and plugin in the process, where Claude Code runs one session per process; keep per-session values in `$.state`. `session.start` and `session.end` fire for root agents only.
- **No sandbox, no static analysis, no hot reload** — the hooks module runs in-process with Node's globals and the process's full authority (its environment, network, filesystem, and tools); the `$`-only access rule, `claude plugin validate`, type generation, `--plugin-dir` watching, and the in-session mod authoring flow are not implemented. Mount only mods you would run as a plugin. Mounting a mod again re-runs `register` on the same evaluated module, so module-level variables keep their values.
- **`turn.complete` text** — the `{ text }` a hook returns reaches the host log, not a line under the answer; `durationMs` counts from the turn's `turn/start`.
- **`$.session.usage`** — `window` is `0` and `percent` absent until the route's context window and a provider usage report are known through the token meter; `rateLimits` is always empty. `$.fs.stat` reports `mtimeMs: 0`.
- **`plugin.json` and `hooks.json`** — not read; `defineMod` carries the identity, and a plugin's settings hooks need `@deepseek-ai/dsh-hooks-claude-code`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The next steps, in order of mod-author value: a docked `Pane` in the Web GUI with `TextInput`, hotkeys, and the toast, status, and log surfaces; `$.model.complete` over `ctx.llm` with a logged request event; and an official mod from `anthropics/claude-code/mods` run by reading, once its license permits a fixture.

</details>
