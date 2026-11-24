---
description: "Add the Feishu plugin to a profile: the official lark-cli with its embedded skills, and Feishu account connection on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

The Feishu plugin lets conversations use Feishu through the official `lark-cli`. It installs a pinned `@larksuite/cli`, downloads a missing `lark-cli` executable, gives the model that executable's absolute path in runtime context, and registers one `feishu` skill that indexes the guides embedded in that CLI. It registers the account with the [connector account registry](../../client/ui-connector-account/README.md), whose Plugins page section checks the default account, links an app and signs in through the CLI's browser flows, signs out, and cancels. The CLI keeps credentials in its default configuration, which the user's own terminal shares. Only macOS and Windows x64 are supported.

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

Install the plugin from the Web sidebar's **Plugins** page or with the CLI:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-feishu
dsh plugin --profile web remove @deepseek-ai/dsh-feishu
```

pnpm blocks the `@larksuite/cli` install script, which downloads and verifies the official native binary; approve it through the Plugins page's **Allow these scripts and retry** or the other paths that [Plugin Manager](../../boot/plugin-manager/README.md) documents. An installation that did not run the script, such as a source checkout or a `link:` install, has no executable; the `feishu` row then loads without it and [downloads it](#cli-download).

<a id="cli-download"></a>
### Download of a missing CLI

When the `feishu` row loads without `binDir` and the `@larksuite/cli` package holds no executable `lark-cli`, the row starts one check, which first runs that package's install script with the Node that runs DSH. The script fetches the release archive for the computer's platform with `curl`, from GitHub and then from npm mirrors, for at most 120 seconds each, verifies its SHA-256 against the package's `checksums.txt`, and copies the binary into the package's `bin` directory. The runtime context gives no `lark-cli` path, and the catalog has no `feishu` skill, until the executable is in place. The download needs no browser; the Plugins page shows it as a step of the check, with **Cancel**. A download that does not finish leaves the account `not-installed`: the page says that the CLI could not be downloaded and offers **Retry**, and unless it was cancelled, the Host log has one warning with the script's exit code and error output. The next check downloads again. Once the executable is in place, a check that fails before it has read the account says that the sign-in state could not be confirmed, with **Retry**, and no longer names the download.

### What you get

Once `lark-cli` is in place, one `feishu` skill joins the skill catalog. The agent loads it with the `skill` tool, opens the guide it needs, such as `lark-doc` or `lark-shared`, with `lark-cli skills read`, and runs `lark-cli` by that path through the ordinary Shell tools under the current sandbox and approval policy. When a command reports a missing app configuration or sign-in, the agent asks the user to connect Feishu on the plugin page; it runs the CLI's own setup and sign-in flow only when the user asks to finish it in the conversation. Commands that save sign-in state ask for single-command approval because they write outside the workspace.

Turning the plugin off in Plugin Manager withdraws the `feishu` skill, the path from runtime context, and the account section. The CLI configuration, the sign-in, and a downloaded executable stay in place.

<a id="account-operations"></a>
### Account operations

The Plugins page drives these operations through the connector account registry, which the Web app loads; a headless profile loads the plugin without it. The Host runs at most one account operation at a time and owns it, so leaving the page does not cancel it. Linking an app and signing in are separate operations, so the page starts each one from its own click. Loading the row starts one check only while `lark-cli` is missing.

| Operation | Effect |
|---|---|
| `check` | Downloads `lark-cli` while it is missing, then checks the account again; each browser that opens the Web app starts one when no operation runs |
| `link-app` | Runs `config init --new`, which replaces the CLI's default configuration, including its sign-ins and any other app, with the app the user creates or chooses; it does not sign in. Replacing a linked app asks first |
| `sign-in` | Runs `auth login --json` for the linked app and checks that the same user is signed in |
| `sign-out` | After the user confirms, runs `auth logout --json`, which also signs out the user's own terminal, then checks again |
| Cancel | Cancels the operation during the download, app setup, or sign-in and waits for its command to exit; other steps are ignored |

A check runs `auth status --verify --json`. The account reads `connected` only when the CLI reports an available user that its server verified, `signed-out` when the user is missing, not configured, or needs a refresh, `unconfigured` when no app exists, and `unverified` otherwise, for example when verification cannot reach the server. `connected`, `signed-out`, and `unverified` carry the configured `appId`. Each link that `config init` prints and each device-authorization link that `auth login` reports is offered only when it is an HTTPS address on `feishu.cn` or `larksuite.com`. A sign-in that leaves requested permissions ungranted (`auth login` exits with code 3 and lists them as missing) still succeeds; a command that later needs a missing permission reports it. Results report succeeded, cancelled, or failed. A failed command shows its name and observed exit code on the page and in the Host log; native messages, paths, and authorization data are omitted. A successful Feishu webpage does not confirm that local credentials were saved. The process running DSH needs access to the CLI configuration and system credential storage; `DSH_HOME` does not relocate either.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | the installed `@larksuite/cli` package's `bin` | Absolute directory containing an executable `lark-cli`, `lark-cli.exe` on Windows; when set, the executable is not downloaded, and the row fails to load with an error that names the path when it is missing |

An account check or sign-out gets the `commandTimeoutMs` of the [`cli-account` row](../cli-account/README.md#use-this-package), 30 seconds by default. App setup and sign-in wait up to 10 minutes for the user in the browser, and each command keeps at most 1 MiB of stdout; the CLI account Service fixes both limits.

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts this package as the `feishu` row after the profile's other layers, and the Plugins page keys the account section by this package name. [`src/index.ts`](src/index.ts) is a function plugin. It registers the path of `lark-cli` and the account with `ctx.cliAccounts`, declares the download of a missing `lark-cli` as the registration's [`prepare` step](../cli-account/README.md#prepare-before-a-check), registers the skill provider, and, while `lark-cli` is missing, starts one check so that a session without a browser also gets the CLI and the skill; with `binDir`, it requires an executable `lark-cli` (`lark-cli.exe` on Windows) there at load. [`src/cli.ts`](src/cli.ts) locates `lark-cli`, downloads a missing one by running the `@larksuite/cli` install script through `ctx.subprocess`, and parses the JSON output of the account commands. A download succeeded when the executable is in place after the script exits, whatever its exit code, because another process running the same script may have put it there. The [CLI account Service](../cli-account/README.md) gives the model that path in runtime context while `lark-cli` is installed, runs the `prepare` step before a check's first command while it is missing, runs each command by the same path, runs one account operation at a time, and reports a failed command by its exit code. [`src/account.ts`](src/account.ts) carries out each operation with the Feishu commands and reads setup and sign-in links from their output lines. [`src/presentation.ts`](src/presentation.ts) maps each view to the section the registry serves, in the text of [`src/locales.ts`](src/locales.ts). Disposal cancels the active operation, aborts running commands and the download, and settles after their processes exit.

[`skills/feishu/SKILL.md`](skills/feishu/SKILL.md) is the only skill this package carries: the DSH guidance, an index of the 28 guides that `lark-cli` 1.0.97 embeds, and how to open them. [`src/skills.ts`](src/skills.ts) reads the entry once when the plugin loads and lists it as the `feishu` provider's one skill with an opaque resource base, so the catalog lists the entry and a load returns the file without running the CLI. It lists the entry only while `lark-cli` is installed. The catalog caches a listing, so after one made without the entry the plugin invalidates the catalog once `lark-cli` is in place. It looks for that after each download attempt and before each account operation, because a cancelled or failed install script may already have copied the binary, and the user can run that script outside DSH. The guides stay in the binary, and the agent reads them with `lark-cli skills read`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [CLI account Service](../cli-account/README.md) — command execution, the CLI path context, and account operations shared by CLI app plugins.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the registry and the Plugins page section that drive the account operations.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation, build-script approval, and enablement.

-----

<a id="model-experience"></a>
## Model Experience

### Skill catalog entry

#### What the model sees

While `lark-cli` is installed, one `feishu` entry appears in the skill catalog with the description below.

##### Catalog description

```markdown
Feishu (飞书) and Lark through the bundled lark-cli: documents and wiki, Base, sheets, slides, Drive files, messages and group chats, calendar, video meetings and minutes, tasks, approvals, mail, contacts, OKR, attendance, events, and the CLI's app setup and sign-in. Load it before any Feishu or Lark task; it indexes the guides and how to open them.
```

#### Token effect

The entry stays in context while the plugin is loaded and `lark-cli` is installed, at about 350 characters.

#### KV Cache effect

The entry is fixed. Loading or unloading the plugin, or `lark-cli` being installed after the catalog was listed, changes the catalog, which is republished as a new message and leaves earlier context in place.

### Loaded skill body

#### What the model sees

A `skill` tool result for `feishu` contains about 6,700 characters: the DSH guidance, an index that gives each of the 28 guides embedded in `lark-cli` 1.0.97 one line with its routing rules, and how to open a guide. The DSH guidance tells the agent to run `lark-cli` by the absolute path from the current runtime context, to ask the user to connect Feishu on the plugin page before running the CLI's setup and sign-in flow itself, and to set the narrowest `sandbox_permissions` for the commands that save sign-in state. The opening instructions tell the agent that the guides are not skills and that it reads a guide, and the files a guide references, with `lark-cli skills read`. Its resource description reads `Embedded lark-cli guides; open them with the skills read command given in the loaded skill.`

#### Token effect

Each load adds the entry body to the retained tool history. Guides and the files they reference arrive as ordinary Shell output when the agent reads them through `lark-cli`.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

### CLI path

#### What the model sees

While the row is loaded and `lark-cli` is installed, the [CLI account Service](../cli-account/README.md#model-experience) adds one required runtime-context entry with the path of `lark-cli` in `binDir`, which defaults to the installed `@larksuite/cli` package's `bin` directory.

##### Runtime-context entry

```markdown
Feishu CLI: run `lark-cli` by its absolute path "<binDir>/lark-cli"; the bare name may resolve to another installation or to none.
```

##### Runtime-context entry on Windows

```markdown
Feishu CLI: run `lark-cli` by its absolute path with the call operator, & '<binDir>\lark-cli.exe'; the bare name may resolve to another installation or to none.
```

#### Token effect

One line of about 110 characters plus the path in each runtime-context snapshot.

#### KV Cache effect

The system prompt does not change; finishing the download, loading or unloading the row, or a changed path appends one runtime-context snapshot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS and Windows x64 are supported; other platforms are unverified.
- Commands must run on this Host. When a composition runs them elsewhere, such as over SSH, the plugin still loads, and each command that runs `lark-cli` fails because the path does not exist there.
- The plugin uses the CLI's default configuration. Signing in or out from DSH affects the user's own terminal, and there is no DSH-private account or account picker. The plugin offers no unbind operation; turning it off keeps the configuration and sign-in.
- Sign-in reads the device-authorization link and the completion from `lark-cli auth login --json` events; a CLI version that changes those events fails the connection with a retryable result.
- The entry's guide index follows `lark-cli` 1.0.97; pinning another `@larksuite/cli` version means checking the index against that version's `lark-cli skills list`.
- Under a file sandbox, a token refresh during an ordinary command can be denied and then needs single-command approval.
- An installation that did not run the `@larksuite/cli` install script needs `curl`, `tar` (PowerShell on Windows), and network access to GitHub or an npm mirror at its first check, and the `feishu` skill and the CLI path are absent until that download succeeds. When the user installs `lark-cli` outside DSH while the plugin is loaded, runtime context gives its path before the catalog has the `feishu` skill, which joins at the next account operation, such as **Retry** on the Plugins page. The page shows no progress. A process that exits during the download, such as a one-shot headless run, stops it, and the next process starts it again. A download stopped that way or cancelled leaves the script's `lark-cli-*` directory, with any partial archive, in the system temporary directory.
- The install script copies the binary into the package's `bin` directory without a rename. A process stopped during that copy can leave an incomplete file that counts as installed; deleting that `bin` directory makes the next check download again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Repository installs deny the `@larksuite/cli` install script in the root `pnpm-workspace.yaml`, so a checkout has no native binary until the plugin first loads without `binDir` and downloads it into `packages/connector/feishu/node_modules/@larksuite/cli/bin`. Specs and the `feishu-skills` session snapshot use stand-in executables through `binDir`; the download specs replace the executable check and the subprocess runtime, so they neither run the script nor write into the package.

</details>
