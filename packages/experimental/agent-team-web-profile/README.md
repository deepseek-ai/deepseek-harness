---
description: "Add the experimental Agent Teams panel to a source-checkout Web profile after the Host Team layer."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-web-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-web-profile` is the private Web layer for [Agent Teams](../agent-team/README.md). Add it after `@deepseek-ai/dsh-web-app` and [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md) to show the Team roster, task board, and teammate navigation in the browser. Removing either experimental layer leaves the stable base and Web composition unchanged. Official releases exclude this package, so it is available only from a source checkout.

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

### Install into a profile

From this repository checkout, add the Host and Web Agent Teams layers to an initialized `web` profile in this order:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-profile
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-web-profile
```

The first command supplies the Team domain, generated Remote methods, and model tools. The second command activates this package's declared patch and its browser presentation. Removing the package with `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-team-web-profile` removes the Web layer from the profile's ordered bundle list.

### What you get

The conversation header gains the Team roster, shared task board, and teammate navigation. [`@deepseek-ai/dsh-experimental-client-ui-agent-team`](../client-ui-agent-team/README.md) owns those browser interactions and mounts the generated Client Remote namespace used to reach the Host Team service.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-web-app` and the Host Agent Teams layer, its single `insert` entry adds the `ui-agent-team` row for `@deepseek-ai/dsh-experimental-client-ui-agent-team`. The inserted Client plugin owns the generated Remote assembly and Team UI; this static bundle holds no mutable state and installs no runtime invariant.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered Web patch containing the `ui-agent-team` row |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| — | No runtime invariant companion is published; the package carries only a static profile patch. The Remote assembly and Team UI own their activation requirements. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and release exclusion.
- [Agent Teams Host profile](../agent-team-profile/README.md) — the required domain, Remote, and model-tool layer.
- [Agent Teams browser UI](../client-ui-agent-team/README.md) — roster, task-board, and teammate-navigation behavior.
- [Web bundle](../../bundle/web-app/README.md) — the stable browser layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Host-side Agent Teams profile selected alongside this Web layer.

#### KV Cache effect

This Web bundle adds no model request content; the Host-side Team tools own prompt, schema, and cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Ordered composition** — `dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile`, and this package must remain in that order.
- **Preset-scoped legacy controls** — stable Web presets still mount continuable Subagent controls inside the preset scope. Top-level Host profile overrides do not replace those scoped registrations, so the Team roster and legacy child controls can both appear until Web has a Team-aware preset. The [Web Agent Teams decision](../../../.agents/notes/implemented/feature/2026-08-06-agent-teams-web.md) records this deferred composition work.
- **Source-checkout only** — official CLI, Web, npm, and Python release payloads exclude this private package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
