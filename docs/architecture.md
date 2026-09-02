# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

Read this before changing anything under `packages/`. It assumes you know Cordis; if you do not, start with the [primer](cordis-primer.md) or the [tutorial](cordis-tutorial/index.md).

We recommend using an agent to explore the codebase and understand its architecture.

## Cordis

[Cordis](cordis-primer.md) is the framework under dsh: plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration.

There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

## Profiles and bundles

A running `dsh` is a plugin tree composed at boot from ordered layers.

A **profile** is a named composition stored in the Harness home. It lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`. `web`, `headless`, `sdk`, `sdk-minimal`, and `acp` ship as templates.

A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it.

Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file.

[`dsh-base`](../packages/bundle/base/README.md) is the shared first layer of the `web`, `headless`, `sdk`, and `acp` profiles: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. [`dsh-web-app`](../packages/bundle/web-app/README.md) adds the browser application, [`dsh-headless`](../packages/bundle/headless/README.md) adds a one-shot runner with no server, [`dsh-sdk-app`](../packages/bundle/sdk-app/README.md) adds the SDK JSON-RPC server, and [`dsh-acp-app`](../packages/bundle/acp-app/README.md) adds the automation-only ACP server. [`dsh-sdk-minimal`](../packages/bundle/sdk-minimal/README.md) is the deliberate exception: one bundle owns its complete explicit SDK tree and does not apply `dsh-base`.

Layers apply to an empty entry list in this order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. A patch targets a row by id and replaces its whole config, or inserts new rows.

Custom profiles default to live patch reload. The shipped `web` profile is live; `headless`, `sdk`, `sdk-minimal`, and `acp` apply all layers once at startup because replacing a one-shot or stdio application's dependencies after it owns work would invalidate that lifecycle.

To see the tree your machine boots:

```sh
dsh --profile web --dump-config
```

Any row it prints can be replaced by a patch of your own.

Composition mechanics are in [app-boot](../packages/boot/app-boot/README.md#profiles); config fields are in the generated [config catalog](config-catalog.md).

## Application launch

Every supported Node application starts at the `dsh` CLI with a named profile. The shipped applications are `dsh web` (the deliberate alias for `--profile web`), `dsh --profile headless`, `dsh --profile sdk`, `dsh --profile sdk-minimal`, and `dsh --profile acp`. The TypeScript SDK resolves its same-version `dsh` dependency and selects `sdk`; custom plugin composition remains a profile plus ordered patch files, not another executable or inline application tree. `sdk-minimal` is a repository-owned standalone bundle behind the same launcher, not a caller-supplied Cordis tree.

Vendored CLIs, build-only and test-only executables, direct in-process plugin mounting, and the private browser WebWorker preview are not Harness application launchers. [`verify-application-entrypoints`](../scripts/verify-application-entrypoints.ts) keeps every package bin, executable source, and root demo in an explicit class and rejects a Node application path that bypasses `dsh`.

The Python SDK follows the same application architecture. Its runtime wheel packages the normal `dsh` CLI as `deepseek-harness-sdk-runtime-<platform>-<arch>`, and the client launches `dsh --profile sdk` with an explicit Harness home by default. The minimal example selects the shipped `sdk-minimal` profile. Python exposes profile selection and ordered patch files rather than a complete Cordis tree; persistent external plugins are installed through `dsh plugin`. The removed private direct-config carrier has no compatibility bin or fallback parser.

## Core packages

Here are some core packages that contribute to the Cordis tree.

| Package | Owns | `ctx` key |
|---|---|---|
| [`core/session`](subsystems/session.md) | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.md) | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.md) | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| [`core/agent`](subsystems/core.md) | The `Agent` interface, live registry, and `agent/*` events | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.md) | The default driver implementing that interface | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.md) | The per-agent scoped-registration primitive | library, no key |
| [`llm/llm`](subsystems/llm-streaming.md) | Message and stream vocabulary plus the adapter seam | `ctx.llm` |
| [`webhook/webhook`](subsystems/webhook.md) | Authenticated-delivery dispatch and Workspace Session creation | `ctx.webhookRuntime` |

## Events

Events are the extension points, and picking the right domain is the first decision in most changes.

- **Session events** are durable facts appended to the log and broadcast through `session/event`. Use one when the fact must survive a reload.
- **Agent events** (`agent/*`) carry a live `Agent`: inbox, step, status, request, validation, continuation. Use one to observe or intercept work in flight.
- **Capability events** attach policy and adapters to a seam (`fs/*`, `tools/*`, `telemetry/*`) without importing the loop.

The [event map](event-producer-consumer.md) lists every event's producers and consumers.

## Turn flow

A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, and `tool/*` are durable session events; the rest are live extension points across three domains. `agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are waterfalls, whose listeners must call `next()` to delegate; `agent/turn-stopping` is serial and has no `next()`.

Input reaches the driver through one inbox. Some messages wake it immediately; injected context waits in the inbox until another message does.

`agent/pre-step` decides what the model sees. Listeners may rewrite the claimed messages or reject them outright; a rejected or empty first claim still closes a durable turn that spent no step, so the log records the attempt. An enter decision may also set `startsRequestSeries` to begin a distinct model-message series: the loop then logs a fresh `request/header` (reason `series`, or `change` carrying `startsSeries: true` when the envelope changed too). A listener that rebuilds a downstream enter decision must spread it (`{ ...decision, messages }`) so the declaration survives. Each step reads the prompt sections and tool schemas that plugins registered.

Details: the [sequence diagram](agent-lifecycle.md), the [tool pipeline](tool-execution-pipeline.md), and [cancellation and error recovery](subsystems/core.md#the-agent-handle).

## Session log

The session log is the source of the context the model sees. `deriveMessages()` projects model history from it, and raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcripts, telemetry, and persistence all derive from this stream.

**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log.

**Projection seam.** `dsh-session-projection` owns `ctx.sessionProjections`: registered units fold committed events incrementally, host consumers read one typed state with `stateOf()`, and carriers batch cropped client views with `snapshot()`. A host reader either requires this service during activation or fails explicitly when the registry or required key is absent. Contributors may retain `ctx.inject(['sessionProjections'], ...)` registration without silently defaulting a missing host value. The agent loop registers shared `turnBoundary` state for its readers ([decision](../.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.md)).

## Capability seams

A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but one role alone is not a seam; adding a capability means designing all three ([capability graph](capability-seams.md)).

Seams are why one provider swap changes the whole product. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks. [Subagent providers](subsystems/subagent.md) vary just as widely behind one interface, from a fresh child agent to a delegated turn in another product.

[Experimental Agent Teams](subsystems/agent-team.md) is a private opt-in coordination seam on `ctx.agentTeams`, with a durable roster, task board, and mailbox layered over continuable subagents.

## Where new behavior goes

New behavior attaches to a documented extension point. Changing the loop itself updates this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.terminals` backend plus `dsh-tool-terminal` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Add background work | register on `ctx.jobs`; `job_*` tools collect or stop it |
| Start a Session from an external webhook | register a trusted rule on `ctx.webhookRuntime` and mount a provider adapter |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add a Web Client Chat node | register a `ConversationNodeDefinition` + keyed renderer |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Generate session titles | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `agent/*` |
| Fork a session at a turn boundary | `ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })` — only agent-loop-published sessions persist |
| Store sessions in a new backend | implement `SessionPersistence` (`create`/`open`/`stat`/`list`/`export`) over the shared handle scaffolding |
| Scope a registration to one agent | use that agent's `agent.ctx` |

The [extension cookbook](cookbook/extension-cookbook.md) maps features to capabilities and indexes the step-by-step guides for [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [settings cards](cookbook/adding-a-settings-card.md). The [Conversation subsystem](subsystems/conversation.md) owns Chat-node assembly.
