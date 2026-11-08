---
description: "Add the DingTalk plugin to a profile: the official dws with its skill, and DingTalk sign-in on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-dingtalk

English | [中文](README.zh.md)

## Summary

The DingTalk plugin lets conversations use DingTalk through the official DingTalk Workspace CLI, `dws`. Installing this bundle adds one row: the CLI with its skill, which also shows the DingTalk account section on the Plugins page, where the user signs in and out without starting a conversation. The CLI keeps the sign-in in `~/.dws` and the system keychain, which the user's own terminal shares. Only macOS and Windows x64 are supported.

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
dsh plugin --profile web add @deepseek-ai/dsh-dingtalk
dsh plugin --profile web remove @deepseek-ai/dsh-dingtalk
```

The bundle has no install script to approve. When the plugin loads, the `dingtalk` row downloads dws for this platform and its skills from the pinned release into the Harness cache; the first load therefore needs network access to GitHub or the official Gitee mirror. Signing in needs a DingTalk account that belongs to an organization whose administrator has turned on CLI access.

### What you get

| Row | Package | Behavior |
|---|---|---|
| `dingtalk` | [`@deepseek-ai/dsh-dingtalk-cli`](../dingtalk-cli/README.md) | Downloads `dws` and its skills, gives the model the absolute path of `dws`, registers its skill, runs account checks, sign-in, and sign-out on the Host, and shows the account section, a connection tag, guidance after the bundle is switched on, and notices on the Plugins page through the [connector account registry](../../client/ui-connector-account/README.md) |

Switching the bundle off withdraws the skill, the path in runtime context, and the page. The CLI sign-in and the downloaded assets stay in place.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `dingtalk` row after the profile's other layers. The package depends on that row package so that the row resolves from this bundle, and [`src/index.ts`](src/index.ts) exports nothing. The Plugins page keys the account section by this package name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [DingTalk CLI and skills](../dingtalk-cli/README.md) — the Host row, its download, account operations, and model guidance.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the registry that shows the account on the Plugins page.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation and enablement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `dingtalk` row, whose package owns the skill catalog entry and loaded skill body described in its [Model Experience](../dingtalk-cli/README.md#model-experience).

#### KV Cache effect

None beyond the `dingtalk` row's skill catalog; the bundle itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS and Windows x64 are supported; the row packages list their own limitations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
