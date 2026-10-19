---
description: "Add experimental one-shot coding-agent delegation through OAR with per-call runtime selection."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-subagent-oar

English | [中文](README.zh.md)

## Summary

Compose this experimental provider with the `subagent_oar` tool to delegate standalone text tasks to Codex and Claude Code in the selected workspace. The provider embeds the OAR library, so no separate OAR CLI installation is required. Codex and Claude Code use their installed native CLIs, authentication, and settings.

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

### Compose a profile

Install and authenticate the native Codex and Claude Code CLIs before delegating to them. Their executables must be available to the DSH Host. The provider starts no native session until a delegation is accepted.

Declare this provider and `@deepseek-ai/dsh-experimental-tool-subagent-oar` as dependencies of your composition, then add these rows through a profile patch:

```yaml
- insert:
    - id: experimental-subagent-oar-codex
      name: '@deepseek-ai/dsh-experimental-subagent-oar'
      config:
        runtime: codex
        providerName: oar-codex
        launchArgs:
          - -c
          - sandbox_mode="workspace-write"
    - id: experimental-subagent-oar-claude
      name: '@deepseek-ai/dsh-experimental-subagent-oar'
      config:
        runtime: claude
        providerName: oar-claude
        launchArgs:
          - --permission-mode
          - dontAsk
          - --permission-prompts
          - none
    - id: tool-subagent-oar
      name: '@deepseek-ai/dsh-experimental-tool-subagent-oar'
      config:
        providers:
          codex: oar-codex
          claude: oar-claude
```

Launch the completed composition through a `dsh` profile. The example assigns each provider a distinct name and fixes its native permission arguments before the model can delegate work.

### What you get

The separate [`subagent_oar` tool](../tool-subagent-oar/README.md) selects a configured runtime for each call. Its package documents the arguments and parent-facing notices.

| `runtime` | Provider | Native permissions in the example |
|---|---|---|
| `codex` | `oar-codex` | Codex `workspace-write` sandbox; no approval prompts |
| `claude` | `oar-claude` | Claude Code `dontAsk`; permission prompts disabled |

Each delegation starts one native session for one text task. The parent Session retains the external task identity and terminal result; this provider creates no DSH child Session and exposes no follow-up or resume operation.

### Configure a runtime instance

Each provider instance selects one OAR runtime and registers a unique `providerName`. To expose another runtime, add its provider row and extend the [external tool's provider mapping](../tool-subagent-oar/README.md#use-this-package). Later profile layers can override these configurations. An unknown OAR runtime id fails when its provider loads.

| Field | Default | Meaning |
|---|---|---|
| `runtime` | required | Runtime id in OAR's default registry |
| `providerName` | `oar` | Name registered with the DSH subagent service |
| `model` | native settings | Optional native model selection |
| `effort` | native settings | Optional native reasoning effort, where supported by the runtime |
| `launchArgs` | `[]` | Native runtime arguments, including permission settings |
| `env` | `{}` | Explicit environment overrides after ambient credential and DSH-variable scrubbing; `null` removes a variable |
| `timeoutMs` | none | Optional turn deadline after startup; omission uses parent cancellation only |

For Claude, select the native permission mode explicitly in `launchArgs` and retain `--permission-prompts none` for unattended work. A Claude instance with no permission-mode argument inherits OAR's permission bypass default. Replacing the example's argument array also replaces its explicit permission settings.

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-subagent-oar) owns accepted fields and validation. A child that needs an API credential from an environment variable must receive it through `env`; native account files remain available through the native runtime's settings.

OAR's pinned default registry includes `antigravity`, `claude`, `codex`, `grok`, `kimi`, `opencode`, and `pi`. Provider configuration accepts every registered runtime id. Codex and Claude have native e2e coverage. Other runtimes need an explicit provider and tool mapping and remain unverified.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The example mounts two instances of the same provider and the [external delegation tool](../tool-subagent-oar/README.md). [`src/index.ts`](src/index.ts) registers providers; the tool package owns runtime selection and task presentation. The provider uses OAR's runtime registry and session API for startup, one prompt, answer collection, cancellation, and disposal. OAR owns native processes; these sessions do not use the DSH subprocess provider.

The dependency patch applies environment overrides to native installation probes. It permits Claude's explicit `--permission-mode` and suppresses OAR's forced permission bypass when that argument is present. The example passes `--permission-mode dontAsk --permission-prompts none`. Codex receives `-c sandbox_mode="workspace-write"`. OAR sets Codex approval policy to `never`. Neither path forwards native approval requests to a DSH interaction UI. Codex startup failure stops app-server and waits for its exit, including a response without a thread id.

Only root assistant text contributes to the answer. When OAR supplies message ids, the last nonempty message is selected; otherwise root text is concatenated. Native reasoning, tool events, and transcript history do not enter the parent Session. Native history follows the selected runtime's own persistence behavior. Provider errors retain native causes for local debugging; default logs emit only safe stage and category summaries because native causes can contain credentials.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — experimental status and optional delivery.
- [Subagent service](../../subagent/subagent/README.md) — provider lifecycle and terminal results.
- [OAR subagent tool](../tool-subagent-oar/README.md) — runtime selection and parent-facing behavior.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — parent scheduling and completion notices.
- [Architecture](../../../docs/architecture.md) — profile layer composition.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The selected native runtime receives the text from `prompt` with `cwd` set to the resolved child directory. Its own model, tools, configuration, and history determine the child request; instance configuration supplies any model, effort, arguments, and environment overrides.

#### Token effect

The native runtime pays for an independent context and turn. Child reasoning and tool traffic are not added to the parent context.

#### KV Cache effect

The child request is independent of the parent's cached prefix. Native runtime behavior determines child cache reuse.

### Parent results, indirectly

#### What the model sees

Through the [external subagent tool](../tool-subagent-oar/README.md#model-experience), the parent receives this provider's selected root answer or failure notice. The consumer owns the tool schema and acknowledgement.

#### Token effect

The terminal notice adds the selected answer or failure detail to the parent context.

#### KV Cache effect

Provider results append through the shared subagent service. The [consumer](../tool-subagent-oar/README.md#model-experience) owns tool-schema changes that affect the parent's cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Experimental runtime coverage:** only Codex and Claude Code have native e2e coverage. Other registered runtimes can be selected but have not been validated by DSH.
- **Native setup:** this provider does not install, authenticate, or upgrade native agents. Missing executables and native configuration failures surface when delegation starts.
- **Unattended permissions:** native permission modes apply without a DSH approval UI. Claude needs a CLI version that supports `--permission-prompts none`; the provider does not expose a tool-restriction feature. OAR records unexpected Codex approval or user-input requests without answering them. If the runtime waits, cancel the task or configure `timeoutMs`.
- **Startup cancellation:** OAR does not expose immediate cancellation while a session is opening. Cancellation waits for that operation and disposes a late session; an explicitly configured `timeoutMs` starts only after opening succeeds.
- **Process and history ownership:** OAR handles native processes, and native runtimes can retain transcripts. DSH does not apply its subprocess sandbox or managed descendant cleanup to those processes.
- **One-shot text:** no continuation, resume, structured output, progress stream, or side-effect rollback is provided. Native changes made before cancellation remain in place.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
