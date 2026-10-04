---
description: "Optional Web profile layer for raw Session logs and Chat node inspection."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-inspector-profile

English | [中文](README.zh.md)

## Summary

Enable this optional bundle to inspect Session data in the Sidebar and open NodeJS Inspector in the bottom panel. It enables both inspectors and Host fetch capture; the bundle itself is off by default in Plugin Manager.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable **Developer Tools** in Plugin Manager's official group. This selects `@deepseek-ai/dsh-experimental-inspector-profile` for the current Web profile.

Open **Session Log** from the Sidebar's new-tab menu or guide. [Session Inspector](../session-inspector/README.md) provides one view with selectable Raw Log and Chat Group presentations; Raw Log is selected initially.

Press **Ctrl/Cmd+Shift+.** to open or collapse **NodeJS Inspector** in the bottom panel with the packaged DevTools frontend. Enabling this bundle starts the local debugging backend and unredacted Host fetch capture; no user override or debugging argument is required.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) enables Session Inspector and the NodeJS Inspector backend with `captureFetch: true`, independently of debugging flags. See the Inspector [README](../inspector/README.md) for debugging and capture behavior. Each plugin owns its behavior and lifetime.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this bundle mounts developer inspection plugins without contributing model context.

#### KV Cache effect

None; the bundle adds no request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web only** — the inspection views require the Web application's Session services.
- **Internal diagnostics** — the component switch remains available, but there is no dedicated Web debugging button. Explicit activation enables unredacted capture and local code execution; see the [security restrictions](../inspector/README.md#security).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
