# Agent Note: Product subagent providers live in the shared profile host

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-product-subagent-providers-in-shared-host.zh.md)

## Problem

The [Codex and Claude Code provider contracts](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md) were first shipped as independently installable packages that a deployment loaded beside the common subagent tool. Agent Presets later became the ordinary owner of one agent's model-visible tools, but a preset cannot safely own these product providers: `ctx.subagents` is a process registry, provider names are unique within the Host, and host consumers resolve the same registry across sessions. Repeated preset composition would therefore contend for the same configured names. Requiring a person to edit both a Profile and a Preset would also make a generic preset row incomplete by itself.

The placement decision must preserve two independent facts. Loading a provider must not start or authenticate a product, while granting a tool must remain per preset so two sessions can expose different products. A global product switch, a provider instance per agent, or pre-enumerated combination presets would each create a second owner for one of those facts.

## Decision

Product providers remain process-scoped host-plane registrations. The [production-install exclusion decision](../simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md) supersedes only this note's former base-bundle installation choice: production `dsh-base` neither depends on nor mounts them. A Profile that opts in installs the selected provider Bundle; its patch mounts the default instance, and the Profile may mount additional named instances on the host plane. The [named-instance decision](../feature/2026-08-18-product-subagent-named-instances.md) owns each row's registry identity: both products accept multiple unique `providerName` values while preserving `codex` and `claude-code` as their defaults. Loading either plugin only registers a dormant backend; the corresponding Codex or Claude process starts on the first actual delegation call. Agent Presets independently contribute ordinary `dsh-tool-subagent` rows whose `provider` and `toolName` values expose exactly the configured instances needed by one agent without changing the Host registry.

Each provider package owns its directly installable Bundle patch and private product runtime. This note continues to own process-wide Host placement whenever either provider is installed. The provider-contract note continues to own each product protocol, result mapping, cancellation, process-tree lifecycle, and evidence tiers. The [named-instance decision](../feature/2026-08-18-product-subagent-named-instances.md) owns both optional product models and other per-instance configuration. The [Agent Preset architecture](2026-08-03-per-session-agent-presets.md) continues to own the Host/Agent split, preset authoring, and the rule that edits affect only newly composed sessions.

Each Bundle delegates executable selection to its package-owned product runtime: the Codex package runs its declared wrapper, while the Claude Code package lets its pinned Agent SDK select the private native executable. Neither provider consults or falls back to a host product command. Profile loading creates no product state, probes no version or authentication, and may supply each mounted Provider instance's deployment configuration, including an optional opaque model and the product-specific `permissionMode` values owned by the [non-interactive permissions decision](../feature/2026-08-15-product-subagent-noninteractive-permissions.md), without moving those choices into an Agent Preset or model-facing tool. Missing platform payloads and product failures remain local to the attempted delegation.

## Verification

The base bundle test proves production `dsh-base` contains neither product provider dependency nor provider row. The Web composition installs both optional Bundles and covers none, Codex-only, Claude-only, and both tool sets, including generation isolation after an authored preset changes. Package-owned Loader compositions prove each Bundle default and additional named instances register without starting a product process. Keyless ACP snapshots pin the Codex two-tool roster and the final four-tool combination, while provider tests separately prove private platform-payload selection without host fallback, configuration isolation, failure, cancellation, and process-tree quiescence.

## Alternatives considered

**Keep product providers opt-in at the Profile layer.** This preserves a smaller default dependency closure but requires the user to edit both a Profile and a Preset. The production-install exclusion decision accepts that installation trade-off; this note retains the requirement that selected provider instances are mounted on the host plane rather than inside the preset.

**Store global or per-Profile product enable switches.** A process switch competes with the Preset as owner of model-visible tools and cannot express two sessions using different combinations. Availability and authentication are deployment facts, not another persisted product state.

**Mount providers inside every Agent Preset.** Provider names belong to a process registry, so repeated session composition would collide on the same configured names. Host consumers also need the registry independently of any one agent's lifetime.

**Ship four product-combination presets.** Four identities duplicate complete compositions to represent two independent tool rows. Ordinary rows already express the full matrix without adding roster or maintenance state.

## Consequences

A user installs each selected product provider in a Profile, mounts the required named instances, and exposes their tools through the same Agent Preset authoring path as other plugins. Each new session receives exactly the tools its chosen preset contributes. Profiles that do not select a product provider carry no corresponding package or module-loading footprint; loading selected instances still starts no product process, login, model call, or product home.

The Host registry remains the single provider authority, each Bundle remains the deployment availability authority, and each Preset remains the model-tool authority. This explicit two-gate lifecycle avoids a global enable switch and keeps package removal independent from per-session authoring.
