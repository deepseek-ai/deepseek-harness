---
description: "Add the WeCom plugin to a profile: the official wecom-cli with its skills, and WeCom authorization on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-wecom

English | [中文](README.zh.md)

## Summary

The WeCom plugin lets conversations use WeCom through the official `wecom-cli`. Installing this bundle adds two rows: the CLI with its skills, and the WeCom authorization section on the Plugins page, where the user binds a bot by scanning a QR code without starting a conversation. The CLI keeps the authorization in its default configuration, which the user's own terminal shares. Only macOS is supported.

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

Install the bundle from the Web sidebar's **Plugins** page or with the CLI:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-wecom
dsh plugin --profile web remove @deepseek-ai/dsh-wecom
```

`@wecom/cli` ships its native binary in a platform package such as `@wecom/cli-darwin-arm64`, which installs without a build script. When no platform package matches the computer, the `wecom` row fails to load with an error that names the missing package.

### What you get

| Row | Package | Behavior |
|---|---|---|
| `wecom` | [`@deepseek-ai/dsh-wecom-cli`](../wecom-cli/README.md) | Puts `wecom-cli` on the private Shell PATH, registers its skills, and runs authorization checks and QR-code connection on the Host |
| `ui-wecom` | [`@deepseek-ai/dsh-client-ui-wecom`](../../client/ui-wecom/README.md) | Shows the WeCom authorization section, an authorization tag, guidance after the bundle is switched on, and notices on the Plugins page |

Switching the bundle off withdraws the skills, the private PATH entry, and the page. The CLI authorization stays in place.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `wecom` and `ui-wecom` rows after the profile's other layers. The package depends on both row packages so that the rows resolve from this bundle, and [`src/index.ts`](src/index.ts) exports nothing. The Plugins page keys the authorization section by this package name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [WeCom CLI and skills](../wecom-cli/README.md) — the Host row, its authorization operations, and its model guidance.
- [WeCom plugin page](../../client/ui-wecom/README.md) — the Plugins page row.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation and enablement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `wecom` row, whose package owns the skill catalog entries and loaded skill bodies described in its [Model Experience](../wecom-cli/README.md#model-experience); the `ui-wecom` row adds nothing model-facing.

#### KV Cache effect

None beyond the `wecom` row's skill catalog; the bundle itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS is supported; the row packages list their own limitations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
