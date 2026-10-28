---
description: "Give the model the absolute path of the official wecom-cli, load its skills, and run the authorization operations the Plugins page drives."
kind: "package-reference"
---

# @deepseek-ai/dsh-wecom-cli

English | [中文](README.zh.md)

## Summary

This package is the Host row of the [WeCom plugin](../wecom/README.md). It installs a pinned `@wecom/cli`, gives the model the absolute path of its `wecom-cli` executable in runtime context, and registers one `wecom` skill whose guides are the official WeCom skills, which it downloads from the WeCom CLI repository on GitHub. Its `wecom` Remote checks the CLI's authorization, binds a bot through the CLI's QR-code page, and cancels, for the [WeCom plugin page](../../client/ui-wecom/README.md). The CLI keeps the bot credentials in its default configuration, which the user's own terminal shares. Only macOS is supported.

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

Install the [WeCom plugin bundle](../wecom/README.md), which inserts this package as the `wecom` row. Until the executable exists, the plugin fails to load with an error that names the missing path or platform package.

### What you get

After the plugin loads, one `wecom` skill joins the skill catalog. The agent loads it with the `skill` tool, opens the guide it needs, such as `wecomcli-doc` or `wecomcli-message`, with the file tools, and runs `wecom-cli` by that path through the ordinary Shell tools under the current sandbox and approval policy. When `wecom-cli auth show --status` reports no authorization, the agent asks the user to connect WeCom on the plugin page; it runs the CLI's own `auth init` only when the user asks to finish it in the conversation, with single-command approval because it writes outside the workspace.

The guides come from `skills/` of `WecomTeam/wecom-cli` at commit `4c74ff2`. The row downloads that commit's archive when it loads and keeps the verified files in `$DSH_HOME/cache/wecom/`; until they are in place, the catalog has no `wecom` skill and the plugin page reports the download. A failed download is retried by the page's check.

Turning the row off in Plugin Manager withdraws the skills and the path from runtime context. The CLI authorization and the downloaded guides stay in place.

<a id="account-operations"></a>
### Authorization operations

The `wecom` Remote serves the Plugins page. It runs at most one operation at a time, owned by the Host, so leaving the page does not cancel it.

| Method | Effect |
|---|---|
| `follow(signal)` | Streams the authorization, the operation in progress, and the last result; each new follower starts a check when no operation runs |
| `check()` | Checks the authorization again; returns the operation id |
| `connect()` | Runs `auth init --noninteractive --no-browser`, waits for the user to scan the QR code, then checks that the CLI reports the bot authorized |
| `cancel(id)` | Cancels that operation while it waits for the scan and waits for its command to exit; other steps and a finished id are ignored |

A check runs `auth show --status`. The authorization reads `authorized` or `unauthorized` exactly as the CLI prints it; any other output or a nonzero exit fails the check and keeps the previous state. Each link that `auth init` prints alone on a stdout line is offered only when it is an HTTPS address on `work.weixin.qq.com`. Results report succeeded, cancelled, or failed. Failures include the command and the observed exit code in the Remote result and Host log; the CLI's output, which can carry the QR-code session, is omitted. `wecom-cli` has no command that revokes the authorization, so the plugin offers no disconnect. The process running DSH needs access to the CLI configuration; `DSH_HOME` does not relocate it.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | the installed `@wecom/cli-<platform>-<arch>` package's `bin` | Absolute directory containing an executable `wecom-cli` |
| `commandTimeoutMs` | `30000` | Deadline for one authorization check, including executable lookup |
| `skillsDir` | none | Directory holding the files of `skills/` at their repository paths; when set, the guides are not downloaded |
| `skillsUrls` | `['https://codeload.github.com']` | Archive download prefixes tried in order |
| `skillsTimeoutMs` | `120000` | How long one prefix may take to deliver the whole archive |

QR-code authorization waits up to 10 minutes for the user, and each command keeps at most 1 MiB of stdout; the [CLI account library](../cli-account/README.md) fixes both limits.

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-wecom-cli) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) is a Remote service registered as `ctx.wecom`. It checks that `binDir/wecom-cli` is executable, gives that path to the model in runtime context, and registers the `wecom` skill through the [upstream skills library](../upstream-skills/README.md) with the pin in [`src/skills.ts`](src/skills.ts). The account view carries the download state, and each check restarts a failed download without waiting for it. [`src/directory.ts`](src/directory.ts) resolves the platform package that `@wecom/cli` installs as an optional dependency. The [CLI account library](../cli-account/README.md) registers that runtime context, runs each command by the same path, and runs one operation at a time. [`src/account.ts`](src/account.ts) extends that runtime with the WeCom commands and reads the QR-code link from the output lines of `auth init`. Disposal cancels the active operation, aborts running commands, and settles after their processes exit.

[`skills/wecom/SKILL.md`](skills/wecom/SKILL.md) is the only skill this package carries: the DSH guidance, an index of the guides, and how to open them. Upstream publishes the guides only in its repository and not in the npm package, so the library downloads them; they are files under the skill's base directory, not separate skills. Where the DSH guidance and `wecomcli-shared` disagree, the entry tells the agent to follow the DSH guidance: it uses the plugin's `wecom-cli` instead of installing one, and sends authorization to the plugin page. References are ordinary files in each guide's directory.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [CLI account library](../cli-account/README.md) — command execution and account operations shared by CLI app plugins.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [WeCom plugin](../wecom/README.md) — the bundle that inserts this row and the page row.
- [WeCom plugin page](../../client/ui-wecom/README.md) — the Plugins page that drives the authorization operations.

-----

<a id="model-experience"></a>
## Model Experience

### Skill catalog entries

#### What the model sees

The skill catalog lists one `wecom` skill. Its Chinese description names the WeCom features it covers and tells the agent to load it, then read the matching guide, whenever the user mentions WeCom or those features or gives a `doc.weixin.qq.com` or `drive.weixin.qq.com` link.

#### Token effect

The entry stays in context while the plugin is loaded. Its name and description total about 160 characters.

#### KV Cache effect

The catalog is fixed for one plugin version. Loading or unloading the plugin changes the catalog, which is republished as a new message and leaves earlier context in place.

### Loaded skill body

#### What the model sees

A `skill` tool result for `wecom` contains about 2,000 characters: the DSH guidance, an index that gives each of the 15 guides one sentence with the upstream routing rules, and how to open a guide. The DSH guidance tells the agent to run the plugin's `wecom-cli` by the absolute path from the current runtime context, to ask the user to connect on the plugin page before running `auth init --noninteractive` itself, and to run that command with single-command approval; it takes precedence over `wecomcli-shared` where they disagree. Its resource base is the downloaded directory, `skillsDir` or `$DSH_HOME/cache/wecom/skills-<digest>`, so the agent opens `skills/<name>/SKILL.md` with the file tools rather than the `skill` tool, treats a skill the guides name as that guide, and resolves a guide's relative paths against the guide's own directory.

#### Token effect

Each load adds the entry body to the retained tool history. Guides and their reference files arrive as ordinary file-read output.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

### CLI path

#### What the model sees

While the row is loaded, the [CLI account library](../cli-account/README.md#model-experience) adds one required runtime-context entry with the path of `wecom-cli` in `binDir`, which defaults to the `bin` directory of the platform package that `@wecom/cli` installs. The second line covers the guide scripts that call `wecom-cli` by name, such as `build_page.py`.

##### Runtime-context entry

```markdown
WeCom CLI: run `wecom-cli` by its absolute path "<binDir>/wecom-cli"; the bare name may resolve to another installation or to none.
Scripts in the WeCom skill call `wecom-cli` by name; prefix only the commands that run them with PATH="<binDir>:$PATH", and never export PATH or run `wecom-cli` by name yourself.
```

#### Token effect

Two lines of about 280 characters plus the path and its directory in each runtime-context snapshot.

#### KV Cache effect

The system prompt does not change; loading or unloading the row, or a changed path, appends one runtime-context snapshot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS is supported. Other platforms are unverified, and the Windows executable name `wecom-cli.exe` is not located.
- Commands must run on this Host. When a composition runs them elsewhere, such as over SSH, the plugin still loads, and each command that runs `wecom-cli` fails because the path does not exist there.
- The plugin uses the CLI's default configuration. Authorizing from DSH affects the user's own terminal, and there is no DSH-private bot or bot picker. `wecom-cli` cannot revoke the authorization, so neither the page nor turning the plugin off removes it.
- Connection reads the QR-code link from the plain-text output of `auth init --noninteractive --no-browser`; a CLI version that changes that output fails the connection with a retryable result.
- The guides follow upstream commit `4c74ff2`; updating them means a new pin from `scripts/upstream-skills-digest.ts`, after which the entry's index and DSH guidance must be checked against the new guides.
- The first load after a new pin needs access to GitHub or a configured mirror; until a download succeeds, the agent has no `wecom` skill.
- The downloaded guides stay in `$DSH_HOME/cache/wecom/` after the plugin is removed or pins another commit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The guides keep upstream whitespace, including trailing spaces that mark Markdown line breaks, and no whitespace exemption covers them: a commit that adds upstream lines with trailing whitespace fails the pre-commit `git diff --cached --check`. Specs and the `wecom-skills` session snapshot use stand-in executables through `binDir`.

</details>
