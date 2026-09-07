# Agent Note: headless is a direct core entry point

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-headless-direct-core-entry-point.zh.md)

## Problem

The `headless` product contract is one local task with final assistant text on stdout, a success-sensitive exit code, no listening port, and the stderr reasoning projection owned by [headless reasoning progress](../feature/2026-08-21-headless-reasoning-progress.md). A composition containing Workspace Host services, browser RPC, HTTP, the Web runtime, or browser plugins contradicts that contract and makes local completion depend on an unrelated transport tree.

The direct entry point still needs the same deployment model state as Web-created Agents. A separate provider/model default would give one deployment two answers, while deriving completion before the Agent and Session persistence are quiescent permits stdout and the exit code to observe incomplete state.

## Decision

The shipped `headless` profile contains `dsh-base` and `dsh-headless`. The base supplies the disabled module-HMR default; the headless bundle supplies its persona and tool mode, mounts the PTC mode worker explicitly, and inserts `headless-runner` without overriding that policy. Its tree contains no browser Connection, HTTP server, Web runtime, or browser client. PTC mode and Session persistence are one-shot Agent capabilities independent of Web presentation.

`headless-runner` is a direct core entry point. After Loader settlement, it reads `ctx.agentDefaultModel.currentSelection()`, creates a fresh persisted Agent through `ctx.agents.create`, installs that `ModelSelection` in the Agent scope, waits for startup quiescence, anchors the Session sequence, submits one ordinary user message, and waits for quiescence again. It awaits `ctx.sessions.flush`, folds its durable event interval for the last non-empty assistant text and final `turn/end` reason, writes the text plus one newline to stdout, and requests bounded launcher shutdown with exit 0 exactly when the reason is `completed`. [Headless reasoning progress](../feature/2026-08-21-headless-reasoning-progress.md) owns the live stderr projection; a terminal `error` reason writes its durable code and message there, and unexpected driver failures also use stderr and exit 1.

`@deepseek-ai/dsh-agent-default-model` owns the transport-independent default used for an Agent without a session-local selection. `AgentDefaultModelConfig` provides `ctx.agentDefaultModel` and registers the `agent-default-model` Settings section. Composition config supplies `{provider, model}`; user settings may also supply `reasoningEffort`. `currentSelection()` returns the live complete selection and `saveSelection()` writes it as a complete section, so a selection without an effort clears any stored effort. `dsh-base` supplies the composition entry. Direct creation and Session Controller Remote calls consume this service; the Session Controller owns session-local precedence, model validation, and persistence of accepted Web selections.

`loadProfile` recognizes the exact installation-owned headless tuple (`dsh-base`, `dsh-web-app`, `dsh-headless`) and normalizes it to the shipped headless template while preserving every other manifest field. Extra, missing, or reordered bundle lists are user-owned and remain untouched.

This note owns the headless transport and completion contracts; [headless reasoning progress](../feature/2026-08-21-headless-reasoning-progress.md) owns successful stderr output. [Apps own their command lines](2026-08-06-app-owned-command-line.md) owns the current `dsh --profile headless` grammar; the former [`dsh run` decision](../../archived/feature/2026-08-08-dsh-run-headless-command.md) records the superseded launcher-owned grammar, [web config-tree boot and transport layering](2026-07-24-web-config-tree-boot-and-transport-layering.md) owns the Web tree, and [the default model follows the picker](../feature/2026-08-07-default-model-follows-the-picker.md) owns persistence of the shared Agent default.

## Verification

Package tests use the real Session store and Agent registry around a scripted Agent factory to pin idle-to-idle aggregation, late asynchronous completion, terminal model diagnostics, other non-completed exits, direct failures, Loader-time disposal, and flush-before-exit ordering. The keyless assembled snapshots drive `dsh --profile headless` through a replayed tool round trip, record a `user/message` with `source.kind: 'user'`, and expose both reasoning progress and a terminal model failure on stderr. Built-bin acceptance reaches a mock DeepSeek endpoint through the published entry and requires streamed reasoning on stderr, final text on stdout, and exit 0. Config-dump acceptance excludes every Host, Web, and Client package from the shipped headless tree; PTY shutdown coverage requires no observation line and bounded disposal.

## Alternatives considered

| Alternative | Contract mismatch |
|---|---|
| Keep `dsh-web-app` but suppress its observation line | The process still opens a port and carries the Host, Web, and browser trees. |
| Build a Host-only one-shot bundle around browser RPC | A local one-shot entry point has no client boundary. |
| Use the in-process Connection carrier for product-level protocol coverage | Product execution would depend on an unrelated protocol solely to exercise that protocol. |
| Give headless a separate provider/model config | Direct and Web creation would have independent defaults and persistence. |
| Omit PTC mode and Session persistence | Both capabilities belong to one-shot Agent execution rather than Web presentation. |
| Normalize every tuple containing Web and headless bundles | Bundle lists are an extension surface; only the exact installation-owned tuple is safe to classify. |

## Consequences

`dsh --profile headless` provides a local Agent task rather than browser observation, Host APIs, or HTTP. Users who need those capabilities choose `dsh web`. Text-only successful runs leave stderr empty, reasoned runs stream the provider-reported content there, completion follows durable flush, and the persisted Session remains available to later tooling. Its initial user message records `source.kind: 'user'` and therefore carries no browser request id.

Connection carrier coverage stays in the Connection package. Custom one-shot profiles may include Host or Web bundles explicitly, while the shipped profile and the recognized installation-owned tuple are Web-free.
