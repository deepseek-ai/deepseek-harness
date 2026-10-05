---
description: "Install the official Feishu lark-cli with a profile, run it by name from the backend and the Shell, and load its embedded skills."
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

The Feishu plugin installs a pinned `@larksuite/cli` with the profile, puts its `lark-cli` executable on the private Shell PATH, and registers the skills embedded in that CLI. The agent runs `lark-cli` by name through the ordinary Shell tools; the backend reads the skills with the same executable. App setup and sign-in happen in the conversation through the CLI's own flow, and the CLI keeps credentials in its default configuration, which the user's own terminal shares. Only macOS is supported.

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

Install the package as a bundle, for example from the Web sidebar's **Plugins** page or with the CLI:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-feishu
```

The bundle patch inserts the `feishu` row after the profile's other layers. pnpm blocks the `@larksuite/cli` install script, which downloads the official native binary from GitHub Releases or npmmirror and verifies its checksum; approve it through the Plugins page's **Allow these scripts and retry** or the other paths that [Plugin Manager](../../boot/plugin-manager/README.md) documents. Until the executable exists, the plugin fails to load with an error that names the missing path.

### What you get

After the plugin loads, the CLI's embedded skills, such as `lark-doc` and `lark-shared`, join the skill catalog. The agent loads one with the `skill` tool and runs `lark-cli` commands through the ordinary Shell tools under the current sandbox and approval policy. When a command reports a missing app configuration or sign-in, the agent follows the CLI's flow: it gives the user a verification URL and QR code, then completes sign-in after the user confirms. Commands that save sign-in state ask for single-command approval because they write outside the workspace.

Turning the row off in Plugin Manager withdraws the skills and the private PATH entry for later Shell calls. The CLI configuration and sign-in stay in place.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | the installed `@larksuite/cli` package's `bin` | Absolute directory containing an executable `lark-cli` |
| `commandTimeoutMs` | `30000` | Deadline for one backend skill command, including executable lookup |
| `maxOutputBytes` | `1048576` | Maximum stdout bytes retained from one backend skill command |

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) requires a Host subprocess runtime, checks that `binDir/lark-cli` is executable, registers `binDir` with [Shell environment](../../shell/shell-env/README.md) as the `feishu` PATH contribution, and registers the skill provider. [`src/cli.ts`](src/cli.ts) prepares the private PATH environment for the subprocess runtime, resolves `lark-cli` in it, and spawns the result with that environment, so the backend and the Shell use the same executable. Each command collects bounded stdout and a stderr tail, rejects a nonzero exit or truncated stdout, and waits for its managed process range to exit. Disposal aborts running commands and settles after their processes exit.

[`src/skills.ts`](src/skills.ts) runs `lark-cli skills list --json` once per registration. A failed catalog is logged once and stays empty until the plugin reloads. Each load runs `skills read <name> --json`, removes the frontmatter, and places the DSH guidance before the vendor body and the CLI's reference-reading guidance after it. References are embedded in the binary, so the skill's resource base is opaque.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [Shell environment](../../shell/shell-env/README.md) — private PATH contributions shared by backend subprocesses and Shell tools.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation, build-script approval, and enablement.

-----

<a id="model-experience"></a>
## Model Experience

### Skill catalog entries

#### What the model sees

Each skill that `lark-cli skills list --json` reports appears in the skill catalog with its vendor name and description; the catalog owner shortens long descriptions. `lark-cli` 1.0.97 reports 28 skills.

#### Token effect

The entries stay in context while the plugin is loaded. For `lark-cli` 1.0.97 they total about 6,000 characters.

#### KV Cache effect

The catalog is fixed for one CLI version. Loading or unloading the plugin changes the catalog, which is republished as a new message and leaves earlier context in place.

### Loaded skill body

#### What the model sees

A `skill` tool result contains the DSH guidance below, the vendor `SKILL.md` body without frontmatter, and the CLI's guidance for reading referenced files with `lark-cli skills read <name> <relative-path>`. Its resource description reads `Embedded lark-cli references; use the skills read command given in the loaded skill.`

##### DSH guidance

```markdown
# Feishu in DSH

Call this integration the Feishu plugin (飞书插件 in Chinese) in user-facing replies. Run `lark-cli` by name in the Host Shell; DSH installs and updates it. It uses the default lark-cli configuration and sign-in shared with the user's own terminal, so do not remove, switch, or sign out of apps or profiles unless the user asks.

When a command reports a missing app configuration or sign-in, load the lark-shared skill and follow its setup and auth flow. Never ask for or print app secrets or tokens.

Commands that save sign-in state, such as `auth login --device-code` and `config init`, write outside the workspace and use up their one-time authorization even when the save is denied: run them with the Shell tool's single-command approval from the start. Run other commands in the existing sandbox and request that approval only when a credential, lock, log, or cache write is denied.

Do not install another lark-cli or run `lark-cli update`.
```

#### Token effect

Each load adds the fixed guidance and one vendor body to the retained tool history. Reference files read through `lark-cli` arrive as ordinary Shell output.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS is supported. Other platforms are unverified, and the Windows executable name `lark-cli.exe` is not located.
- The plugin requires a subprocess runtime on this Host and fails to load when the composition's subprocess runtime runs elsewhere, such as over SSH.
- The plugin uses the CLI's default configuration. Signing in or out from DSH affects the user's own terminal, and there is no DSH-private account or account picker. The plugin offers no unbind operation; turning it off keeps the configuration and sign-in.
- There is no Host-side account status or operation; setup and sign-in happen in the conversation.
- Under a file sandbox, a token refresh during an ordinary command can be denied and then needs single-command approval.
- A failed skill catalog stays empty until the plugin reloads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Repository installs deny the `@larksuite/cli` install script in the root `pnpm-workspace.yaml`, so a checkout has no native binary. To run the plugin from source against the real CLI, run `node packages/connector/feishu/node_modules/@larksuite/cli/scripts/install.js` once. Specs and the `feishu-skills` session snapshot use stand-in executables through `binDir`.

</details>
