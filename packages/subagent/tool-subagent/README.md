---
description: "Model-facing subagent delegation tool for users and maintainers configuring, composing, or debugging delegation over a subagent provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

## Summary

Use this package to give an agent a named tool that delegates work to a configured backend. Every call starts a managed activation and returns a child id; the runtime owns completion notices and cleanup. Local children support messages and restoration, while external backends execute one task and return their final answer through the completion notice. Supported backends can expose approved child LLM routes. Each instance can select a child preset and depth limit.

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

The optional `cwd` argument selects the child's initial working directory. Relative paths resolve against the caller's current directory; omission inherits it. Existing children retain their own directories when the caller changes directory.

Mount one instance per delegation target, each with a distinct `toolName`. The tool exists exactly while its provider does, so sibling load order and provider reloads never strand it.

### Minimal configuration

Load the subagent service, an in-process or remote backend, and this tool; then name the provider. This composition exposes a `subagent` tool that delegates to the `spawn` backend:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Provider name on `ctx.subagents` (e.g. `spawn`, `fork`, `acp`) |
| `toolName` | `subagent` | Model-facing tool name; distinct for every loaded instance |
| `modelSelection` | `false` | Expose optional child route fields; requires provider `agentOptions` support |
| `modelDiscovery` | `false` | Register `list_subagent_models`; enable on one instance per tool scope |
| `agentOptions` | — | Configured child `provider`, `model`, adapter-owned `reasoningEffort`, and positive `maxTokens` defaults; requires provider `agentOptions` support and overlays any provider-owned route defaults |
| `agentPreset` | — | Default independent child preset id; requires in-process spawn |
| `allowedAgentPresets` | — | Non-empty preset-id allowlist exposed as the model's optional `agent_preset` enum; must include `agentPreset` when both are set |
| `maxDepth` | Host setting (`1`) | Absolute delegation-depth cap (`0` forbids delegation); `'provider-managed'` sends no cap to an out-of-process provider |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent) is the exhaustive source for every accepted field and its JSDoc.

### Managed delegation

Every call returns `started subagent <childId>` after the runtime accepts the child. It does not wait for the child's result. The activation owns the work independently of the completed tool call; the runtime sends a completion notice and releases execution resources.

Every backend’s completion notice carries its final answer. Local Spawn and Fork children can also send messages, accept more work through `send_message` while active, or resume after settling. Codex, Claude Code, ACP, and DSH SDK backends do not accept follow-up messages.

`maxDepth` caps recursion (`0` forbids delegation); omission reads the current Host `subagent.maxDepth` setting, initially `1`, at each delegation. A numeric depth requires a provider with the `depthLimit` capability; `'provider-managed'` leaves the budget to an out-of-process provider. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and rejects with an errored result.

<a id="selecting-a-child-preset"></a>
### Selecting a child preset

Set `agentPreset` to give every child an independent preset by default. Set `allowedAgentPresets` to let the model choose an id through `agent_preset`; without this allowlist, the model cannot override the configured choice. Only in-process spawn supports these options; fork and external backends reject them.

Duplicate or empty preset ids fail at load. The selected preset is resolved when a call starts the child; an unknown or unloadable preset returns an errored tool result without starting a child. Creating a parent Agent or switching its preset does not resolve child references. Without either selection field, the tool does not require the preset service. An omitted model choice uses the configured `agentPreset`, or joins the parent's current preset revision when no default is configured. Any explicit id mounts the currently available revision, even when it matches the parent's id.

Compose persona and tools in the [preset plugin list](../../preset/agent-preset-registry/README.md). Tool configuration containing `persona` or `toolFilter` fails at load with a migration error. Local children use the shared [preset restoration rules](../subagent/README.md#restoring-child-composition).

### Selecting a child LLM

Set `modelSelection: true` to expose optional `provider`, `model`, and `reasoning_effort` fields; instances without it reject selection fields. Set `modelDiscovery: true` on one instance per tool scope to register `list_subagent_models`; it defaults off independently of `modelSelection`. A second discovery owner in the same scope fails to register. Discovery follows its owning plugin instance, remains available when its delegation provider is absent, and is removed when that instance unloads. Web and Desktop presets enable discovery and route fields on spawn and leave both disabled on fork. The Host’s `/model-selection-settings` service samples the user preference during Agent creation, independently of tool installation. Its creation listener subscribes before projection registration completes and awaits the handle; registration failure or owner disposal rejects Agent publication. When enabled, its exact route list is recorded in each fresh top-level Session, inherited by child Sessions, and preserved on restore; later settings edits affect only new Sessions. Without a recorded Session policy, discovery and explicit selection permit only the parent Agent’s current effective provider/model and its supported efforts. Route fields require a backend that advertises `agentOptions`; in-process Spawn and Fork and DSH SDK qualify, while ACP, Codex, and Claude Code fail the mount.

A call supplies `provider` and `model` together, or supplies only an effort when configured, parent, or provider-owned defaults provide the route. Static `provider.agentRouteDefaults`, when present, form the provider/model baseline; tool configuration and model fields overlay it before route-aware effort merging and exact-route preflight. Providers without these defaults use compatible values from the parent's latest logged request, then the parent's creation options before its first request, while retaining the configured `maxTokens`. Changing the route without an explicit effort clears the inherited route-owned effort, so the selected model resolves its default. The live LLM adapter validates the effective route before child creation. Catalog membership remains advisory, so a model can use an unlisted id when its adapter accepts it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool mirrors provider lifecycle and settles runs; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One instance is one provider plus one tool name. The plugin registers its definition in the owning composition while the provider is present and disposes it when the provider leaves. Each preset revision owns one shared registration, including tools with preset selection. Agents inherit its definitions; switching presets changes scope ancestry without reinstalling tools. Discovery belongs to the instance configured with `modelDiscovery` and reads the same durable Session policy as the delegation executor. A numeric `maxDepth` or configured LLM selection unsupported by the provider fails the mount. Multiple distinctly named delegation tools may expose model selection in one scope.

### Activation ownership

The tool calls `ctx.subagents.startActivation()` with parent delivery selected. The runtime owns startup cancellation, execution, outcome reporting, and cleanup. A startup failure is an errored tool result; failures after publication arrive through the completion notice, with diagnostics and partial output preserved by the runtime.

### Result acknowledgement

The canonical tool result is `{ kind: 'activation', subagentId }`. It contains no execution Promise or final output; programmatic consumers that need to await results use the subagent service directly.

### Context-sensitive wording

The tool's description derives from `provider.inheritsParentContext`: a fresh child gets "it does not see this conversation" wording, a forked child gets "it does not see the current in-flight turn" wording, so the model never restates or omits context that does not exist.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool registration, provider lifecycle mirroring, activation requests |
| [`src/preset-selection.ts`](src/preset-selection.ts) | Preset defaults, model allowlist, and selection guidance |
| [`src/model-selection.ts`](src/model-selection.ts) | Request/config merge and live LLM route preflight |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | Host-owned opt-in setting sampled for new Sessions |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | Session event that records and inherits the sampled decision |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` runtime discovery tool |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool's runtime behavior to the seam it delegates over and the adjacent child tools.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — providers, activations, results, and continuation.
- [dsh-tool-subagent-control](../tool-subagent-control/README.md) — messaging, interrupt, and listing tools for continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) — the default schema and backend-specific wording.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent) — every accepted config field.
- [Historical model-selected subagent routes](../../../.agents/notes/archived/feature/2026-08-18-model-selected-subagent-routes.md) — selection policy, inheritance, discovery, and the fork restriction.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) appears under the configured tool name while its provider exists. An instance with `modelSelection` adds `provider`, `model`, and `reasoning_effort` plus route guidance in every Session. `allowedAgentPresets` adds the `agent_preset` enum and guidance for the default or inherited selection. Context inheritance and continuation support determine task and follow-up descriptions. Agent restrictions apply to inherited preset delegation tools in schemas, execution, and guidance, including when historical `toolFilter` overrides are restored; sibling Agents remain unaffected. Preset-selection guidance depends only on the tool configuration, so it does not depend on other presets’ declaration order.

#### Token effect

Fixed schema cost per parent request; `modelSelection` adds three optional route fields, while preset selection adds one enum parameter and default guidance. Each tool instance adds one schema; visible delegation tools share one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances and their configuration are unchanged. Adapter catalog changes do not alter the definition. Shipped fork tools omit model-selection fields to preserve reuse of the inherited parent prefix. A custom fork tool may enable selection; changing its route can prevent prefix reuse.

### Model selection and discovery

#### What the model sees

The optional `list_subagent_models` definition reads the calling Session’s route policy, falling back to the current parent route when no policy is recorded. Calls reject while the optional `ctx.llm` service is unavailable. With a recorded policy, provider model lists intersect the advertised catalog with the Session’s authorized routes. Without one, they resolve only the current parent model, even if the catalog omits it. The discovery tool’s own description instructs the model to query options before selecting a child route; omitting or filtering out discovery removes that guidance. Exact-model queries accept authorized ids absent from the catalog; unauthorized provider/model lookups fail before adapter access. Catalog or exact-model lookup failures and cancellation reject the call. Execution independently enforces the same policy.

#### Token effect

One fixed discovery schema is present wherever `modelDiscovery` is enabled, regardless of the Session’s preference or the owning instance’s `modelSelection` option; the shipped Web and Desktop presets include it, while headless, SDK, and ACP profiles do not. Route metadata enters the transcript only when the model calls the tool.

#### KV Cache effect

The schema is prefix-stable across adapter registration and catalog changes. Each discovery result is appended after the reusable prefix.

### System prompt

#### What the model sees

Visible delegation tools share one guidance paragraph, listing tools in name order and instructing the model to start independent delegations together and keep working while they run, and to end its turn instead of sleeping or polling when only waiting for their results remains. Ending the turn works because a settled child notifies its parent and a notice that reaches an idle parent starts one independent model request; hosts that keep children progressing alternate `agent.whenIdle()` and `waitForChildren(agent)` ([`dsh-subagent`](../subagent/README.md), [`session.ts`](../../acp/acp/src/session.ts)). Hidden or unavailable tools are omitted; no guidance appears when none are visible. With both `subagent` and `subagent_fork` visible, the text is:

##### Tool-guidance section

```markdown
Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.
```

#### Token effect

At most one short delegation paragraph per parent request, listing the tool names visible to that request.

#### KV Cache effect

Prefix-stable while the visible tool names are unchanged; adding or removing a visible tool changes the paragraph.

### Runtime depth context

#### What the model sees

When the calling agent reaches or exceeds a visible tool's effective numeric depth cap, an optional runtime-context snapshot tells it to do the work directly. The cap is resolved again at each request, including after settings changes or session resume. Hidden tools and `provider-managed` limits contribute no depth text. For a child at depth one with a cap of one:

##### Depth-limit notice

```markdown
Delegation depth for `subagent`: current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.
```

#### Token effect

One short contribution per capped tool joins the user-role runtime-context snapshot. Unchanged snapshots are not appended again; agents below the cap receive no additional text. `includeRuntimeContext: false` suppresses this notice without changing runtime depth enforcement.

#### KV Cache effect

Depth changes do not alter the system prompt or tool schemas. Updated runtime context appends after existing history; the provider still enforces the cap if the model attempts delegation.

### Start result

#### What the model sees

The call retains the task description and prompt. Success returns `started subagent <childId>`; startup rejection returns an error. Child execution details are delivered separately from this acknowledgement.

#### Token effect

The prompt and acknowledgement remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Completion delivery

#### What the model sees

Answer delivery follows the managed delegation rules above. The returned child id identifies subsequent control and catalog operations; only backends with continuation support accept follow-up messages.

#### Token effect

Messages and completion notices append to parent history independently of the start acknowledgement. The tool result itself contains no final output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what this tool does not return or enforce; they are current package constraints.

- **This tool does not wait for results** — use the completion notice or child messages. Programmatic result waiting belongs to the subagent service.
- **Preset choices omit descriptions** — `agent_preset` exposes ids and default or inheritance guidance only. The schema does not read candidate preset documents, so registration is independent of their declaration order. Use ids that convey each candidate's purpose.
- **Preset references are checked on delegation** — Host-mounted and preset-mounted tools both resolve the target when starting a child. A target can be declared or replaced after tool registration, so loading the tool cannot establish its availability for a later call. Misspelled or unavailable ids remain undetected until selected; that call returns an error.
- **Shipped fork tools omit model selection** — their configuration leaves `modelSelection` disabled to preserve inherited-prefix reuse. Custom fork tools may enable it under the same Session authorization and adapter validation as other delegation tools.
- **Depth caps are fixed per instance** — another cap requires another distinctly named tool. Child personas and tools belong to the selected Agent Preset. Explicit LLM selection requires `modelSelection` and is restricted to the Session’s authorized routes, or the current parent route without an enabled policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
