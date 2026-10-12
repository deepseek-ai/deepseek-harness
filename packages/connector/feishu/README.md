---
description: "Add the Feishu plugin to a profile: the official lark-cli with its embedded skills, and Feishu account connection on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

The Feishu plugin lets conversations use Feishu through the official `lark-cli`. Installing this bundle adds two rows: the CLI with its embedded skills, and the Feishu account section on the Plugins page, where the user links an app and signs in without starting a conversation. The CLI keeps the account in its default configuration, which the user's own terminal shares. Only macOS is supported.

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
dsh plugin --profile web add @deepseek-ai/dsh-feishu
dsh plugin --profile web remove @deepseek-ai/dsh-feishu
```

pnpm blocks the `@larksuite/cli` install script, which downloads and verifies the official native binary; approve it through the Plugins page's **Allow these scripts and retry** or the other paths that [Plugin Manager](../../boot/plugin-manager/README.md) documents. Until the executable exists, the `feishu` row fails to load with an error that names the missing path.

### What you get

| Row | Package | Behavior |
|---|---|---|
| `feishu` | [`@deepseek-ai/dsh-feishu-cli`](../feishu-cli/README.md) | Puts `lark-cli` on the private Shell PATH, registers its embedded skills, and runs account checks, connection, and sign-out on the Host |
| `ui-feishu` | [`@deepseek-ai/dsh-client-ui-feishu`](../../client/ui-feishu/README.md) | Shows the Feishu account section, a connection tag, guidance after the bundle is switched on, and connection notices on the Plugins page |

Switching the bundle off withdraws the skills, the private PATH entry, and the page. The CLI configuration and sign-in stay in place.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `feishu` and `ui-feishu` rows after the profile's other layers. The package depends on both row packages so that the rows resolve from this bundle, and [`src/index.ts`](src/index.ts) exports nothing. The Plugins page keys the account section by this package name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [Feishu CLI and skills](../feishu-cli/README.md) — the Host row, its account operations, and its model guidance.
- [Feishu plugin page](../../client/ui-feishu/README.md) — the Plugins page row.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation, build-script approval, and enablement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `feishu` row, whose package owns the skill catalog entries and loaded skill bodies described in its [Model Experience](../feishu-cli/README.md#model-experience); the `ui-feishu` row adds nothing model-facing.

#### KV Cache effect

None beyond the `feishu` row's skill catalog; the bundle itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS is supported; the row packages list their own limitations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
