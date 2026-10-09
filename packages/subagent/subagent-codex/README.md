---
description: "The one-shot Codex subagent provider for users and maintainers choosing a product backend, installing a Profile bundle, or configuring an unattended Codex delegation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-codex

English | [中文](README.zh.md)

## Summary

Install `@deepseek-ai/dsh-subagent-codex` into a Profile when delegated work should run in a genuine, unattended Codex session in the parent Session's workspace. Each delegation uses a fresh isolated Codex thread for one self-contained text task and returns only its final answer or a safe failure diagnostic. Native Codex configuration and authentication remain authoritative, while `permissionMode` selects the non-interactive approval and sandbox behavior. The Bundle supplies a compatible native Codex payload and adds its delegation tool as a global tool.

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

Enable **Codex subagent** in the Web or Desktop Plugins page when a task needs a fresh native Codex session in the parent workspace.

### Installing the Bundle

The Official entry is visible offline. Enabling it installs the [target for the running DSH installation](../../boot/plugin-manager/README.md#use-this-package) through the ordinary bundle installer and selects its profile layer. The layer registers the provider and adds `subagent_codex` to every Agent as a global tool; it starts no native process until delegation. Restart when the installer reports that one is required.

Switching Off deselects the layer and leaves the package installed. Remove is a separate package operation. Enabling or switching Off registers or removes the global tool in the running Host, so live Agents see the change on their next request.

The layer inserts Host rows only, so any profile can select it, including the shipped headless, SDK, and ACP profiles. Existing provider-only consumers follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.md).

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `codex` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Codex settings | Optional non-empty model name fixed for every thread from this provider instance; omission sends no app-server override |
| `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment |
| `permissionMode` | `never` | Native non-interactive approval and sandbox mode fixed for every thread from this provider instance |
| `disposeGraceMs` | `3000` | Grace between the shared managed-range owner's termination tiers |

| `permissionMode` value | `thread/start` fields | Native behavior |
|---|---|---|
| `never` | `approvalPolicy: never`; sandbox omitted | Never ask for approval; execution failures return to the model under the native sandbox |
| `approve-for-me` | `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, `sandbox: workspace-write` | Route permission requests through Codex automatic review without a human |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access` | Skip approval and sandbox enforcement; this value must be selected explicitly |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-codex) is the exhaustive source for every accepted field and its JSDoc. A configured `model` passes unchanged on each ephemeral `thread/start`; omission leaves native model selection in force. The provider does not discover models, rewrite aliases, select `modelProvider` or `serviceTier`, or set a fallback. Credential-shaped ambient variables are removed before the explicit `env` overlay, so an API key intended for the child must be supplied there.

<a id="exposing-the-tool"></a>
### Exposing the tool

The bundle inserts `tool-subagent-codex` as a Host row, so `subagent_codex` is a global tool visible to every preset, including minimal. Later user patches can configure or disable that row by id. A preset that registers its own tool with the same name shadows the global tool for its Agents. To mount the provider and tool without selecting the bundle layer, insert the same rows in `cordis.patch.yml`:

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

The tool returns a child id after accepting the task and sends its result to the parent Agent on completion. Each external activation executes once and accepts no follow-up input or resume.

### What you get

The completion notice contains the final Codex answer, or the stop reason and optional safe diagnostic. The parent Session also retains the external task identity and complete terminal result independently of the notice; no local child Session is created. Product reasoning, tool activity, raw stderr, and workspace diffs do not enter the parent Session.

### Failure and recovery

An install that omits optional dependencies, uses an unsupported platform, or loses the selected payload leaves the provider dormant and fails the first delegation at `initialize` with a safe `unknown` category and any observed process outcome; there is no host-CLI fallback. Raw wrapper text stays on Host stderr. A cancelled run settles as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider drives a real Codex app-server and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One fresh process, thread, and turn per run.** Every run spawns a fresh app-server, creates one ephemeral thread, and executes exactly one turn; there is no continuation, resume, or pooling.
- **Native configuration is authoritative.** Codex configuration and authentication stay native through the parent cwd, `HOME`, and `CODEX_HOME`; the provider overrides only the optional model and the thread's approval, reviewer, and sandbox fields.
- **Unattended by design.** Approval, user-input, and MCP requests are answered or declined without a human; unknown server requests fail the run.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | The run lifecycle, turn execution, result selection, and diagnostics |
| [`src/wire.ts`](src/wire.ts) | The minimal app-server JSON-RPC wire implementation |
| [`cordis.patch.yml`](cordis.patch.yml) | The Profile layer that registers the provider and contributes preset delegation tools |

### Run flow

A start accepts only a non-empty sequence of text blocks and uses the child cwd selected by the subagent service. It spawns the fixed command through the subprocess seam, performs the `initialize` → `initialized` handshake, maps the Profile-selected mode and optional model into official `thread/start` fields beside `{ cwd, ephemeral: true }`, and publishes the run only after Codex returns a valid ephemeral thread. The published result starts exactly one turn, accepts only notifications for that run's thread and turn, and waits for the authoritative `turn/completed` terminal. The latest `agentMessage` with `phase: "final_answer"` wins; when Codex emits no explicit final phase, the latest message with `phase: null` is the compatibility fallback. A successful turn with no nonblank answer settles as an error. Failed turns use the coarse categories `limit`, `access-policy`, `service`, `transport`, `product-error`, `invalid-result`, or `unknown`; an early app-server exit uses `process`, and applicable connection and stream failures retain a numeric `httpStatusCode`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this provider to the seam it plugs into and the sibling product provider.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Claude Code subagent provider](../subagent-claude-code/README.md) — the sibling product backend over the official Agent SDK.
- [historical Claude Code and Codex backends](../../../.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) — the design record for the product providers.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-codex) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The Codex child receives the standalone text blocks as one turn in a fresh ephemeral thread. Its workspace is the selected child working directory; the selected Provider instance fixes any configured model, environment, non-interactive approval policy, and sandbox mode, while an omitted model and every other product setting come from native Codex configuration. The executable version comes from the Bundle's pinned platform payload.

#### Token effect

The child pays for an independent Codex context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Codex's own provider, model, instructions, tools, and ephemeral-thread request.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent model first receives a child id, then the final Codex answer or a failure notice with its stop reason and safe diagnostic. Diagnostics contain only fixed stage, category, and observed protocol or process facts. Product reasoning, intermediate messages, tool activity, stderr, usage, product identifiers, commands, paths, and raw protocol payloads are not copied into the parent Session.

#### Token effect

Parent input grows by the start acknowledgement and completion notice, including the final answer or failure detail. Child tokens do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Start acknowledgements and completion notices append after the reusable parent request prefix. A notice may wake another turn without rewriting the existing prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this provider is a poor fit or needs special operational care. They are current package constraints, not a general Codex comparison or a task backlog.

- **One fresh process, thread, and turn per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Static instance selection** — Profile rows fix provider names, optional models, and tool bindings; calls cannot choose or change either a provider or model dynamically, and every exposed tool needs a unique `toolName`.
- **Authentication and account state remain native** — the Bundle supplies the CLI but does not create an account, log in, trust a project, or rewrite Codex settings; configuration and authentication failures surface with their lifecycle stage and the safe `unknown` fallback rather than a separate public taxonomy.
- **The native platform payload is required at delegation time** — installs that omit optional dependencies, unsupported platforms, and missing or damaged payloads fail at the first run; there is no host-CLI fallback.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.153.4 protocol baseline requires regenerating upstream schema evidence and rerunning handshake, answer-selection, approval, cancellation, keyless real-product, and credentialed DeepSeek nonce tests.
- **No human approval path** — known unattended approval requests are denied and unknown server requests fail closed; the three Profile modes never create a DSH interaction channel or per-call allow policy.
- **Assistant payload is final text only** — failed runs can also expose a separate safe diagnostic; reasoning, intermediate messages, tool traffic, usage, stderr, and workspace diffs remain outside the parent Session. Task identity and terminal results are retained in the parent log.
- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Payload size disclosure** — the current darwin-arm64 platform payload packs to about 114 MB and unpacks to about 282 MB; these are disclosure numbers, not installation thresholds.
- **Version-pinned protocol** — the runtime dependency is pinned to `@openai/codex@0.153.4`; upgrading requires regenerating the upstream schema evidence and rerunning the credentialed nonce tests.

</details>
