---
description: "The agent loop's settings page on the dsh web client's Plugins page: the parallel tool-call cap of the agent-loop namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-agent-loop

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Agent loop** in the Official group to set how many parallel-safe tool calls one step may run at once. The page stages what is typed and writes it only on save, marks a value the user overrode, and offers to reset it to the deployment's default. The page exists while the Host serves the `agent-loop` namespace.

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

The **Agent loop** card in the Official group opens the page. **Parallel tool calls** bounds the calls the loop runs at once within one step; the field renders the effective value, and once overridden carries an **Overridden** badge with **Reset to default** beside it. Nothing is written until **Save**; leaving the page drops the draft, an empty field saves as a reset, and text that is not a number blocks the save and says so under the field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `agent-loop` namespace through `ctx.configForms.get`, keeps the staged form in `AgentLoopCardController` over the shared `SettingsFormModel` of `ui-primitives`, and registers `AgentLoopCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`. The page's copy lives in this package's `settings.agentLoop` dictionary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [agent-loop](../../core/agent-loop/README.md) — the loop that registers the `agent-loop` namespace.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One field of the namespace** — the Host section carries only the parallel cap; the composed `agents` array is boot composition, not a user setting, and has no field here.
- **Runtime invariant:** No companion is published. The page holds no owned relationship of its own: what it shows derives from the settings mirror, and what it writes the Host validates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
