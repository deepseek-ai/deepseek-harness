---
description: "Put the official Feishu lark-cli on the private Shell PATH, load its embedded skills, and run the account operations the Plugins page drives."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-cli

English | [中文](README.zh.md)

## Summary

This package is the Host row of the [Feishu plugin](../feishu/README.md). It installs a pinned `@larksuite/cli`, puts its `lark-cli` executable on the private Shell PATH, and registers the skills embedded in that CLI. Its `feishu` Remote checks the CLI's default account, links an app and signs in through the CLI's browser flows, signs out, and cancels, for the [Feishu plugin page](../../client/ui-feishu/README.md). The CLI keeps credentials in its default configuration, which the user's own terminal shares. Only macOS is supported.

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

### Add it to a profile

Install the [Feishu plugin bundle](../feishu/README.md), which inserts this package as the `feishu` row; that page covers approving the `@larksuite/cli` install script. Until the executable exists, the plugin fails to load with an error that names the missing path.

### What you get

After the plugin loads, the CLI's embedded skills, such as `lark-doc` and `lark-shared`, join the skill catalog. The agent loads one with the `skill` tool and runs `lark-cli` commands through the ordinary Shell tools under the current sandbox and approval policy. When a command reports a missing app configuration or sign-in, the agent asks the user to connect Feishu on the plugin page; it runs the CLI's own setup and sign-in flow only when the user asks to finish it in the conversation. Commands that save sign-in state ask for single-command approval because they write outside the workspace.

Turning the row off in Plugin Manager withdraws the skills and the private PATH entry for later Shell calls. The CLI configuration and sign-in stay in place.

<a id="account-operations"></a>
### Account operations

The `feishu` Remote serves the Plugins page. It runs at most one account operation at a time, owned by the Host, so leaving the page does not cancel it. Linking an app and signing in are separate operations, so the page starts each one from its own click.

| Method | Effect |
|---|---|
| `follow(signal)` | Streams the account, the operation in progress, and the last result; each new follower starts a check when no operation runs |
| `check()` | Checks the account again; returns the operation id |
| `linkApp()` | Runs `config init --new`, which replaces the CLI's default configuration, including its sign-ins and any other app, with the app the user creates or chooses; it does not sign in |
| `signIn()` | Runs `auth login --json` for the linked app and checks that the same user is signed in |
| `signOut()` | Runs `auth logout --json`, which also signs out the user's own terminal, then checks again |
| `cancel(id)` | Cancels that operation and waits for its command to exit; a finished id is ignored |

A check runs `auth status --verify --json`. The account reads `connected` only when the CLI reports an available user that its server verified, `signed-out` when the user is missing, not configured, or needs a refresh, `unconfigured` when no app exists, and `unverified` otherwise, for example when verification cannot reach the server. Every state except `unconfigured` carries the configured `appId`. Each link that `config init` prints and each device-authorization link that `auth login` reports is offered only when it is an HTTPS address on `feishu.cn` or `larksuite.com`. A sign-in that leaves requested permissions ungranted (`auth login` exits with code 3 and lists them as missing) still succeeds; a command that later needs a missing permission reports it. Results report succeeded, cancelled, or failed. Failures include the command, observed exit code, and recognized CLI error categories in the Remote result and Host log; native messages, paths, and authorization data are omitted. A successful Feishu webpage does not confirm that local credentials were saved. The process running DSH needs access to the CLI configuration and system credential storage; `DSH_HOME` does not relocate either.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | the installed `@larksuite/cli` package's `bin` | Absolute directory containing an executable `lark-cli` |
| `commandTimeoutMs` | `30000` | Deadline for one skill command, account check, or sign-out, including executable lookup |
| `authorizationTimeoutMs` | `600000` | Deadline for app setup or sign-in, which wait for the user in the browser |
| `maxOutputBytes` | `1048576` | Maximum stdout bytes retained from one command |

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu-cli) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) is a Remote service registered as `ctx.feishu`. It requires a Host subprocess runtime, checks that `binDir/lark-cli` is executable, registers `binDir` with [Shell environment](../../shell/shell-env/README.md) as the `feishu` PATH contribution, and registers the skill provider. [`src/cli.ts`](src/cli.ts) prepares the private PATH environment for the subprocess runtime, resolves `lark-cli` in it, and spawns the result with that environment, so the backend and the Shell use the same executable. Each command reads stdout and stderr through pipes, reports each complete line to an optional observer, keeps stdout up to `maxOutputBytes` and the last 4 KiB of stderr, and waits for its managed process range to exit. [`src/account.ts`](src/account.ts) owns the account operations and reads setup and sign-in links from those lines. Disposal cancels the active operation, aborts running commands, and settles after their processes exit.

[`src/skills.ts`](src/skills.ts) runs `lark-cli skills list --json` once per registration. A failed catalog is logged once and stays empty until the plugin reloads. Each load runs `skills read <name> --json`, removes the frontmatter, and places the DSH guidance before the vendor body and the CLI's reference-reading guidance after it. References are embedded in the binary, so the skill's resource base is opaque.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [Shell environment](../../shell/shell-env/README.md) — private PATH contributions shared by backend subprocesses and Shell tools.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [Feishu plugin](../feishu/README.md) — the bundle that inserts this row and the page row.
- [Feishu plugin page](../../client/ui-feishu/README.md) — the Plugins page that drives the account operations.
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

When a command reports a missing app configuration or sign-in, first ask the user to connect Feishu on the Feishu plugin page in Plugins. Load the lark-shared skill and run its setup and auth flow yourself only when the user asks to finish it in this conversation. Never ask for or print app secrets or tokens.

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
- Sign-in reads the device-authorization link and the completion from `lark-cli auth login --json` events; a CLI version that changes those events fails the connection with a retryable result.
- Under a file sandbox, a token refresh during an ordinary command can be denied and then needs single-command approval.
- A failed skill catalog stays empty until the plugin reloads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Repository installs deny the `@larksuite/cli` install script in the root `pnpm-workspace.yaml`, so a checkout has no native binary. To run the plugin from source against the real CLI, run `node packages/connector/feishu-cli/node_modules/@larksuite/cli/scripts/install.js` once. Specs and the `feishu-skills` session snapshot use stand-in executables through `binDir`.

</details>
