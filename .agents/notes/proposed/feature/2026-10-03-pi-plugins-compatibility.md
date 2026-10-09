# Agent Note: Pi plugins compatibility — levels of support

Status: proposed

English | [中文](2026-10-03-pi-plugins-compatibility.zh.md)

## Problem

Pi 1.0.0 has two separate mechanisms for running customization code. Extensions are in-process TypeScript factories with a published API; the [Pi extensions bridge note](2026-10-03-pi-extensions-bridge.md) covers them. Plugins are a newer mechanism built on Pi's Chord composition runtime: a plugin package contributes facets, and each facet runs in the process its name selects. This note covers plugins.

A compatibility layer for Pi plugins is not worth building today, for two reasons the upstream sources state themselves.

- **The API is unpublished and unstable.** The plugin stack runs only with `PI_EXPERIMENTAL=1`. The `./experimental/plugin` export of `@earendil-works/pi-coding-agent` has only a `source` condition, and the npm tarball excludes its build output. Chord's plan says it "is not a stable public API contract yet" ([PLANNING.md](https://github.com/earendil-works/pi/blob/v1.0.0/packages/chord/PLANNING.md)), and pi-durable, which the Session worker runs on, says its "API changes without notice between releases" ([README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)). The [services README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/experimental/services/README.md) lists `AgentController.navigate()`, `nextRun()`, and `resume()` as dropped.
- **A plugin can do less than an extension.** The Session worker builds its tool, hook, and prompt registry itself and does not expose it as a service, so a facet cannot register a model tool, intercept a tool call, or change the prompt. Pi ships one example plugin.

Deferring the work without a record loses two results of the investigation: the mapping from Pi's plugin services onto DSH services, which decides what each increment of support costs, and the DSH runtime properties that differ from Chord's, which matter to DSH independently of Pi.

## Proposal

Treat Pi-plugin compatibility as six levels. Each level names what a plugin author gets, the upstream change that makes it worth building, and the DSH work it needs. DSH stays at level 0 until the trigger of a higher level occurs. A level includes the levels below it, except that level 4 replaces the Host-side presentation of level 2.

| Level | Support | Upstream trigger | DSH work |
|---|---|---|---|
| 0 | None. This note is the only artifact. | — | Re-read the upstream status when Pi releases. |
| 1 | `session` facets run in one Chord host per DSH Session. `AgentController`, `Models`, and `SessionPlugins` are served over DSH services. | Pi ships the plugin API in its npm package, or removes the `PI_EXPERIMENTAL` requirement. | One experimental Host package. No core change. |
| 2 | `tui` facets run on the Host. Their slash commands become DSH commands, `select` becomes a user question, and `showStatus` a status line. Pi's example plugin runs unmodified. | Same as level 1. | Adapters, plus the Web status display of the Pi extensions bridge. |
| 3 | `Transcript` is served, and a Session's plugin selection is stored with the Session. | A plugin that consumes `Transcript` exists, or pi-durable declares `ConversationView` stable. | A projection from the Session log to `ConversationView`, and a per-Session selection record. |
| 4 | `tui` facets run in the browser and reach Session services through a generic Chord bridge. | Chord commits to browser support, and Pi defines a presentation facet that is not terminal-specific. | One generic JSON Remote endpoint, a browser facet loader, and argument text for Client commands. |
| 5 | Parity: one worker per Session, and plugins register model tools and hooks. | Pi exposes its tool and hook registry to facets. | Per-Session process isolation, and the tool and hook mappings of the Pi extensions bridge. |

## What a Pi plugin is

A plugin is a package directory. Its `package.json` may carry `chord.facets`, which maps a facet name to an entry file or disables it; without the field, Pi uses `src/session.ts` and `src/tui.ts` when they exist. An entry default-exports `{ id, setup(env) }`. `setup` is synchronous and only declares: `env.use` and `env.observe` acquire services, `env.provide` and `env.provideMany` publish them, `env.replicatedState` creates shared state, and `env.own`, `env.onActivate`, and `env.onDeactivate` attach lifecycle work. The Chord host validates the complete dependency graph, activates providers before consumers, and can replace a facet whose declared services are unchanged while consumers keep their service handles.

The server builds each entry with Chord's esbuild bundler into a content-addressed CommonJS file listed in `chord-facets.json`. The Session worker loads the `session` entry with `node:vm` after checking its SHA-256 digest, and `require` resolves only the externals the entry declared. The `tui` entry reaches each client as a JSON artifact in a service response and loads the same way. The loader is not a sandbox: plugin code runs with the process's full authority.

`pi server -e <package>` sets the server's default plugins, and `pi client -e <package>` selects plugins for one Session. Pi stores a Session's selection and refuses a different selection while that Session's worker is running.

Pi serves these to facets:

| Scope | Service | Members |
|---|---|---|
| server | `SessionDirectory`, `SessionManagement`, `PresentationPlugins` | Session list state; create, remove, attach, detach; build and reload of presentation artifacts |
| session | `AgentController` | `prompt`, `steer`, `followUp`, `cancelQueued`, `abort`, `compact`, `waitForPrompt` |
| session | `Models` | replicated catalog and selection state; `select`, `selectThinking`, `cycleThinking`, `getThinkingLevels`, `refresh` |
| session | `Transcript` | the root conversation's pi-durable `ConversationView` as replicated state |
| session | `SessionPlugins` | `reload` |
| presentation, process-local | `SlashCommands` | `register`, `replace`, `list`, `subscribe`; a command has a name, description, argument hint, optional argument completions, and `run(args, context)` |
| presentation, process-local | `PresentationUI` | `select(title, items, selected, context)`, `showStatus(message, context)` |

A service that is not process-local may contain only replicated JSON state and methods whose arguments and result are JSON and whose last parameter is a Chord `Context`.

## Level 1: session facets

The package depends on `@earendil-works/chord` at one exact version. It builds each selected package with `bundleFacetPackage` into a cache under the Harness home and loads the `session` entry with `createFacetBundleLoader`. Chord neither installs dependencies nor runs lifecycle scripts, so a package arrives with its dependencies installed.

The loader resolves two externals itself. `@earendil-works/chord` resolves to the package's own Chord instance, because Chord identifies replicated state through a registry held by the module instance. `@earendil-works/pi-coding-agent/experimental/plugin` resolves to a module that defines service tokens with Pi's IDs (`pi.agent-controller`, `pi.local.presentation-ui`, `pi.local.slash-commands`); Chord matches services by ID string, so a token defined outside Pi binds to a facet compiled against Pi's.

The package creates one Chord host per Agent in `agent/created` and disposes it with the Agent's context. Built-in facets serve Pi's Session services:

| Pi member | DSH mechanism | Difference |
|---|---|---|
| `AgentController.prompt` | `agent.followup()` | Refusal with `busy` is derived from `agent.status`. |
| `steer`, `followUp` | `agent.steer()`, `agent.followup()` | None. |
| `cancelQueued` | `agent.inbox.remove()` | Telling `already_consumed` from `not_found` reads the Session log. |
| `abort` | `agent.cancel()` | None. |
| `compact` | `ctx.compaction.compactNow()` | Non-null `customInstructions` is refused; DSH compaction takes none. |
| `waitForPrompt` | A fold over Session events from the queued message to its `turn/end` | DSH does not link a prompt to its answer; the fold does. |
| `Models` | The model catalog and model selection of `session-controller` | Reasoning-effort identifiers stand in for Pi's thinking levels. |
| `SessionPlugins.reload` | Rebuild, `FacetHost.reload()`, then dispose the retired generation | None. |

`Transcript` is not provided at this level. Chord rejects a host whose facet requires a service nobody provides, so a plugin that uses `Transcript` fails to load with an error naming it.

## Level 2: presentation facets on the Host

Pi's `tui` facets use no terminal API. They consume `SlashCommands`, `PresentationUI`, and Session services, so they can run in a second Chord host per Agent on the DSH Host, bound in-process to the Session host.

A registered slash command becomes an Agent-scoped `ctx.commands` registration whose handler passes the raw input as `args`. A command run on the Host is logged as `command/run` and `command/done`; Pi does not log presentation commands. `getArgumentCompletions` has no DSH counterpart and is not called. `PresentationUI.select` maps to `ctx.userQuestions.ask()` and needs a connected Web Client; `showStatus` maps to the status display the Pi extensions bridge adds to the Web Client.

## Level 3: transcript and stored selection

`Transcript` requires a projection from DSH Session events to pi-durable's `ConversationView`: entries in pi-durable's entry kinds plus its live, inbox, agent, and usage documents. The projection is lossy where DSH records events Pi has no entry for, and it binds DSH to a type pi-durable declares unstable.

A Session's plugin selection is stored as a `plugin:`-prefixed ignorable Session record, the mechanism the Pi extensions bridge uses for extension state, and a live Agent's selection is fixed, as in Pi.

## Level 4: presentation facets in the browser

Running `tui` facets in the page matches Pi's placement of presentation code. It needs three additions. A browser loader evaluates the CommonJS artifact, because Chord's artifact loader uses the filesystem and `node:vm`. One generic Remote endpoint carries Chord's service calls, snapshots, and updates as JSON between the page and the Host, because DSH generates Remote methods at build time and the Client does not discover Host services at runtime. Client commands accept argument text, which `ui-commands` actions do not receive today.

## Level 5: parity

Pi isolates each Session in a worker process and plans to give plugins tools and hooks through its registry. Matching that needs a DSH Session to run in its own process or worker thread with Chord's service protocol across the process boundary, and, once Pi exposes the registry, the tool, hook, and prompt mappings that the Pi extensions bridge already defines.

## Runtime differences the plugin model exposes

| Property | Chord and Pi | DSH | Levels affected |
|---|---|---|---|
| Provider replacement | A consumer holds a handle that resolves the current provider on each access; a reload swaps the implementation behind it. | A fiber whose injected service changes is unloaded and re-run. | 1: the Chord host keeps Chord's behavior for services between facets; a DSH service mapped into Chord still restarts its adapter. |
| Fault isolation | One worker process per Session. | All Sessions share the Host process, and an uncaught exception or unhandled rejection disposes the application ([app-boot](../../../../packages/boot/app-boot/README.md)). | 1–4 run plugin code in the Host; 5 removes the difference. |
| Remote declaration | A host publishes a service's remote members from the object it was given at runtime. | Remote methods are generated at build time, and the Client does not discover Host services at runtime ([remotes](../../../../packages/api/remotes/README.md)). | 4 |
| Shared state | Replicated JSON state with operation batches, hydration, and gap recovery, read through one API locally and remotely. | Each domain defines its own snapshot and delta types, or publishes complete projection values. | 3, 4 |
| Runtime loading | One bundle per facet, loaded outside the module cache after an integrity check. | Packages are built ahead of time; a built installation does not transpile TypeScript. | 1 adds Chord's bundler as a dependency of the plugin package. |

## Chord mechanisms to evaluate for DSH

Four Chord mechanisms address limits DSH has independently of Pi. Each needs its own proposal; this note only records them.

- **Stable service handles.** A consumer keeps its handle while a provider is replaced, so a plugin reload does not restart its dependents and lose their state.
- **Declaration before activation.** Setup declares every dependency synchronously, and the host rejects a missing provider, a duplicate provider, or a cycle before any facet activates. Cordis resolves dependencies as services appear, so a fiber with a missing provider stays pending until an audit after startup reports it.
- **Replicated JSON state.** One primitive gives local and remote consumers complete immutable values, with operation batches on the wire and a full reset when a subscriber falls behind.
- **Verified plugin artifacts.** A content-addressed bundle with a manifest digest lets a host load a plugin generation outside the module cache and release it when retired.

## Alternatives considered

**Build levels 1 and 2 now as a prototype.** The API is unpublished, has one example plugin, and its services README already lists three `AgentController` methods as dropped. A prototype would need maintenance against each Pi release without a user. The service mapping above keeps the design result without that cost.

**Skip the record and decide when Pi stabilizes.** The service mapping and the runtime comparison took a full reading of Chord and Pi's experimental server, worker, and client. The runtime differences also apply to DSH work that has nothing to do with Pi.

**Implement Pi's plugin services on Cordis without Chord.** A facet calls Chord's API directly: `env.use`, `env.provide`, and `replicatedState`. Serving that API without Chord means reimplementing graph validation, stable handles, keyed services, and replicated state. Chord is MIT-licensed, has one runtime dependency, and is the runtime plugins are compiled against.

**Add plugins to the Pi extensions bridge package.** The two mechanisms share no API and have different stability. Separate packages let each be enabled, versioned, and removed without the other.

**Run presentation facets only in the browser.** Level 2 reuses Pi's Node artifacts unchanged and needs no browser loader. Browser support is an open decision in Chord's plan, and Pi has no presentation facet that is not terminal-specific.

## Acceptance criteria

- **Level 0:** this note is merged, and the Pi extensions compatibility page links to it for the plugin mechanism.
- **Level 1:** the `session` facet of Pi's example plugin loads from its unmodified package directory. A test calls its greeting service and every served `AgentController` member against a real agent loop with a mock model. `SessionPlugins.reload` replaces the facet generation without recreating the Chord host, and disposing the Agent disposes the host.
- **Level 2:** `/hello <name>` from Pi's example plugin runs through `ctx.commands`, shows its status text in the Web Client, and submits its prompt.
- **Level 3:** a facet that subscribes to `Transcript` receives the root conversation after hydration and after each committed step, and a resumed Session loads the plugins it was created with.
- **Level 4:** the `tui` facet of Pi's example plugin runs in the browser, and its service calls reach the Host through the generic endpoint.
- **Every level:** a compatibility page lists each difference from Pi, and the package's README states that plugin code runs in the Host with its full authority.

## Risks

- The upstream API can change or be withdrawn before a level is built. The service mapping describes Pi 1.0.0 and needs a re-read against the release that triggers the work.
- Levels 1 to 4 run plugin code in the Host process, where one uncaught error stops every Session.
- Level 3 depends on a pi-durable type that upstream declares unstable.
- Level 4 adds a Remote endpoint whose payloads are validated by Chord's wire parsers instead of generated per-method codecs.
- The plugin package brings esbuild as a runtime dependency through Chord's bundler.
