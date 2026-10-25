---
description: "Expose one external subagent tool that selects a configured runtime for each task."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-subagent-oar

English | [中文](README.zh.md)

## Summary

Use one `subagent_oar` tool to choose a configured external agent for each standalone text task. Configuration fixes the available runtime aliases and their providers; the model selects an alias without changing native arguments or permissions. Each task uses independent context and returns its child id and full name, with a later completion notice delivered to the parent.

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

Mount this tool with `@deepseek-ai/dsh-subagent-names` beside configured external providers, such as [OAR provider instances](../subagent-oar/README.md). Declare the naming, tool, and provider packages as dependencies of your composition.

### When to choose it

Choose this tool when one model-facing entry should select among independent, one-shot providers. It rejects providers that inherit the parent conversation or support continuation. Use the [shared subagent tool](../../subagent/tool-subagent/README.md) for continuable child agents or broader child configuration.

### Minimal configuration

With the shared subagent services available and `oar-codex` and `oar-claude` already registered, mount the naming service once alongside this tool:

```yaml
- name: '@deepseek-ai/dsh-subagent-names'
- name: '@deepseek-ai/dsh-experimental-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

| Field | Default | Meaning |
|---|---|---|
| `providers` | required | Nonempty map from model-visible runtime aliases to registered provider names |
| `toolName` | `subagent_oar` | Tool name; every mounted instance needs a distinct name |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-subagent-oar) owns accepted fields and validation. A call requires `runtime`, `description`, and `prompt`; optional `name` selects a sibling segment under the [naming service rules](../../subagent/subagent-names/README.md); optional `cwd` selects the child directory, with relative paths resolved from the parent's current directory. The prompt must contain the context the child needs. Native installation, authentication, model settings, and permissions belong to the selected provider.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) registers the configured runtime choices and calls `ctx.subagents.startActivation()` directly. The naming service reserves a sibling name and maps the accepted child id to its full name; the child's prompt is the submitted task. The subagent service owns capacity, parent lifetime, cancellation, terminal recording, and completion delivery. The tool's call card uses the task description and submitted arguments. Disposing the plugin removes its tool registration; the activation manager retains ownership of accepted children.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent service](../../subagent/subagent/README.md) — provider registration and activation ownership.
- [Subagent names](../../subagent/subagent-names/README.md) — sibling names and full-name lookup.
- [OAR provider](../subagent-oar/README.md) — native runtime setup and permission configuration.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — parent completion notices and retained results.

-----

<a id="model-experience"></a>
## Model Experience

### External delegation tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-subagent-oar) owns the description and argument schema. The `runtime` enum contains the configured aliases. After acceptance, the result contains `kind: "activation"`, `subagentId`, and `name`. The model sees `started subagent <ID>` followed by `name: <full name>` on the next line. The shared subagent service later supplies the child's answer or failure notice, identifying the external execution by the same child id.

#### Token effect

Each mounted instance adds one tool schema. The acknowledgement and completion notice append to the parent context; the provider owns the child's independent context and token use.

#### KV Cache effect

Changing the configured aliases, tool name, or registration changes the tool schema in later requests. Acknowledgements and completion notices append after the reusable parent prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The tool's choices and execution capabilities are fixed by its configured providers.

- **One-shot providers only:** child context is independent, and the tool exposes no follow-up, resume, structured output, or per-call native permission override.
- **Provider availability:** a selected provider that is absent or unloaded fails at call time; its configured alias remains in the schema until this tool's configuration changes.
- **Name binding failure:** if the accepted child's name cannot be recorded, the error reports its id and leaves execution managed by the subagent service. Check that child's outcome before retrying; the reserved name is released.
- **Provider-owned work:** runtime setup, startup cancellation, process cleanup, and answer selection follow the selected provider's documented behavior. Removing this tool does not revoke accepted activations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
