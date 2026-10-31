---
description: "Add the Tencent Meeting plugin to a profile: the official tmeet with its skill, and Tencent Meeting sign-in on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tencent-meeting

English | [中文](README.zh.md)

## Summary

The Tencent Meeting plugin lets conversations use Tencent Meeting through the official `tmeet` CLI. Installing this bundle adds one row: the CLI with its skill, which also shows the Tencent Meeting account section on the Plugins page, where the user signs in and out without starting a conversation. The CLI keeps the sign-in in its default configuration, which the user's own terminal shares. Only macOS and Windows x64 are supported.

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
dsh plugin --profile web add @deepseek-ai/dsh-tencent-meeting
dsh plugin --profile web remove @deepseek-ai/dsh-tencent-meeting
```

`@tencentcloud/tmeet` declares an install script, so the first installation stops with `@tencentcloud/tmeet` among the pending build scripts. On the Plugins page, select **Allow these scripts and retry**; with the CLI, set `allowBuilds` for it to `true` in the profile's `pnpm-workspace.yaml` and run the command again. The script makes the packaged executable executable and runs `tmeet auth logout`, which signs out tmeet on this computer, including the user's own terminal. The approval stays in the profile, so each later installation of a new `@tencentcloud/tmeet` version runs the script and signs out again; sign in again on the plugin page afterwards.

### What you get

| Row | Package | Behavior |
|---|---|---|
| `tencent-meeting` | [`@deepseek-ai/dsh-tencent-meeting-cli`](../tencent-meeting-cli/README.md) | Gives the model the absolute path of `tmeet`, registers its skill, runs account checks, sign-in, and sign-out on the Host, and shows the account section, a connection tag, guidance after the bundle is switched on, and notices on the Plugins page through the [CLI account registry](../../client/ui-cli-account/README.md) |

Switching the bundle off withdraws the skill, the path in runtime context, and the page. The CLI sign-in stays in place.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `tencent-meeting` row after the profile's other layers. The package depends on that row package so that the row resolves from this bundle, and [`src/index.ts`](src/index.ts) exports nothing. The Plugins page keys the account section by this package name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [Tencent Meeting CLI and skills](../tencent-meeting-cli/README.md) — the Host row, its account operations, and its model guidance.
- [CLI account surfaces](../../client/ui-cli-account/README.md) — the registry that shows the account on the Plugins page.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation, build-script approval, and enablement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `tencent-meeting` row, whose package owns the skill catalog entry and loaded skill body described in its [Model Experience](../tencent-meeting-cli/README.md#model-experience).

#### KV Cache effect

None beyond the `tencent-meeting` row's skill catalog; the bundle itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS and Windows x64 are supported; the row packages list their own limitations.
- Installing a new `@tencentcloud/tmeet` version signs out tmeet on this computer, because its approved install script runs `tmeet auth logout`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
