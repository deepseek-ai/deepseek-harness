---
description: "Add the Tencent Meeting plugin to a profile: the official tmeet with its skill, and Tencent Meeting sign-in on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tencent-meeting

English | [中文](README.zh.md)

## Summary

The Tencent Meeting plugin lets conversations use Tencent Meeting through the official `tmeet` CLI. It installs a pinned `@tencentcloud/tmeet`, gives the model the absolute path of its platform executable in runtime context, and registers one `tencent-meeting` skill whose guide is the official `tmeet-skill`, downloaded from the CLI's GitHub repository. It registers the account with the [connector account registry](../../client/ui-connector-account/README.md), whose Plugins page section checks the sign-in, signs in through the CLI's authorization page, signs out, and cancels. The CLI keeps the sign-in in its default configuration, which the user's own terminal shares. Only macOS and Windows x64 are supported.

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
dsh plugin --profile web add @deepseek-ai/dsh-tencent-meeting
dsh plugin --profile web remove @deepseek-ai/dsh-tencent-meeting
```

`@tencentcloud/tmeet` declares an install script, so the first installation stops with `@tencentcloud/tmeet` among the pending build scripts. On the Plugins page, select **Allow these scripts and retry**; with the CLI, set `allowBuilds` for it to `true` in the profile's `pnpm-workspace.yaml` and run the command again. The script makes the packaged executable executable and runs `tmeet auth logout`, which signs out tmeet on this computer, including the user's own terminal. The approval stays in the profile, so each later installation of a new `@tencentcloud/tmeet` version runs the script and signs out again; sign in again on the plugin page afterwards. When the package has no executable for the computer's platform, or the executable is missing, the plugin fails to load with an error that names the platform or path.

### What you get

After the plugin loads, one `tencent-meeting` skill joins the skill catalog. The agent loads it with the `skill` tool, opens the `tmeet-skill` guide and its references with the file tools, and runs `tmeet` by that path through the ordinary Shell tools under the current sandbox and approval policy. When a command reports a missing or expired sign-in, the agent asks the user to connect Tencent Meeting on the plugin page; it runs `tmeet auth login --no-browser` only when the user asks to finish it in the conversation, and requests `sandbox_permissions` with a `justification` on the first attempt because the command writes outside the workspace.

The guide comes from `skills/tmeet-skill/` of `TencentCloud/tencentmeeting-cli` at tag `v1.0.18` (commit `e631b35`), without `scripts/agent_init.py`. The row downloads that commit's archive when it loads and keeps the verified files in `$DSH_HOME/cache/tencent-meeting/`; until they are in place, the catalog has no `tencent-meeting` skill, the runtime context gives no `tmeet` path, and the plugin page shows the download instead of the account. The page's check waits for the download and shows it as a step with **Cancel**. A download that does not finish leaves the account at `not-installed`: the page reports that the skill could not be downloaded and offers **Retry**, and the next check downloads again.

Turning the plugin off in Plugin Manager withdraws the skill, the path from runtime context, and the account section. The CLI sign-in and the downloaded guide stay in place.

<a id="account-operations"></a>
### Account operations

The Plugins page drives these operations through the connector account registry, which the Web app loads; a headless profile loads the plugin without it. The Host runs at most one operation at a time and owns it, so leaving the page does not cancel it.

| Operation | Effect |
|---|---|
| `check` | Waits for the guide's download while it is missing, starting one when none runs, then checks the account again; each browser that opens the Web app starts one when no operation runs |
| `sign-in` | Runs `auth login --no-browser`, waits for the user to authorize on the Tencent Meeting page, then checks that the server accepts the new sign-in |
| `sign-out` | After the user confirms, runs `auth logout`, which also signs out the user's own terminal, then checks again |
| Cancel | Cancels a sign-in while it waits for authorization, or a check while it waits for the guide's download, and waits for the command or download to stop; other steps are ignored |

A check runs `auth status`, which in tmeet 1.0.18 prints plain text and exits with code 0 whether or not a user is signed in. The account reads `signed-out` for `Not logged in.`, for `Session has expired.`, or when `Logged in` comes with an expired refresh token; `connected`, with the user name, when `Logged in` comes with a `UserName:` line, which the CLI prints only after its user-info request to the server succeeds; and `unverified` for any other `Logged in`, for example when that request cannot reach the server. A nonzero exit or other output fails the check and keeps the previous account, except that `not-installed` becomes `unchecked` once the download is in place; a download that does not finish leaves `not-installed`. The link that `auth login` prints on its `authorize url:` stdout line is offered only when it is an HTTPS address on `meeting.tencent.com`. Results report succeeded, cancelled, or failed. Failures show the command and the observed exit code on the page and in the Host log; the CLI's output, which can carry the one-time authorization code, is omitted. The process running DSH needs access to the CLI configuration in `~/.tmeet`, the encrypted credentials in `~/Library/Application Support/tmeet`, and the macOS Keychain item that holds their key; `DSH_HOME` does not relocate them.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | unset, which runs the installed `@tencentcloud/tmeet` executable for this platform | Absolute directory containing an executable `tmeet`, `tmeet.exe` on Windows |
| `skillsDir` | none | Directory holding the files of `skills/tmeet-skill/` at their repository paths; when set, the guide is not downloaded |

An account check or sign-out gets the `commandTimeoutMs` of the [`cli-account` row](../cli-account/README.md#use-this-package), 30 seconds by default. Sign-in waits up to 10 minutes for the user, and each command keeps at most 1 MiB of stdout; the CLI account Service fixes both limits. tmeet itself stops waiting for authorization after 5 minutes. The guide is downloaded from the `skillsUrls` of the [`upstream-skills` row](../upstream-skills/README.md#use-this-package), each within its `skillsTimeoutMs`.

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-tencent-meeting) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts this package as the `tencent-meeting` row after the profile's other layers, and the Plugins page keys the account section by this package name. [`src/index.ts`](src/index.ts) is a function plugin. It resolves the `tmeet` executable, registers the `tencent-meeting` skill with `ctx.upstreamSkills` under the pin in [`src/skills.ts`](src/skills.ts), and registers that path and the account with `ctx.cliAccounts`. The registration's [`prepare` step](../cli-account/README.md#prepare-before-a-check) is the skill handle's `installed` and `install`, so each check first waits for the guide's download and starts one when none runs. `@tencentcloud/tmeet` ships one executable per platform under `dist/`, each named for its platform, and its `bin` is a Node launcher. [`src/directory.ts`](src/directory.ts) therefore picks the executable for `process.platform` and `process.arch` with the same names the launcher uses, and both the runtime context and the plugin's own commands use that path. The [CLI account Service](../cli-account/README.md) gives the model that path in runtime context while the guide is in place, runs the `prepare` step before a check's first command while it is missing, runs each command by the same path, runs one operation at a time, and reports a failed command by its exit code. [`src/account.ts`](src/account.ts) carries out each operation with the tmeet commands, reads the authorization link from the output lines of `auth login`, and parses the `auth status` text. [`src/presentation.ts`](src/presentation.ts) maps each view to the section the registry serves, in the text of [`src/locales.ts`](src/locales.ts). Disposal cancels the active operation, aborts running commands and the guide's download, and settles after the commands' processes exit.

[`skills/tencent-meeting/SKILL.md`](skills/tencent-meeting/SKILL.md) is the only skill this package carries: the DSH guidance, an index of the guide, and how to open it. Upstream publishes the guide only in its repository and not in the npm package, so the [upstream skills Service](../upstream-skills/README.md) downloads it; it is a set of files under the skill's base directory, not a separate skill. The pin excludes `scripts/agent_init.py`, which records the calling agent and model in the CLI configuration for upstream telemetry. Where the DSH guidance and the guide disagree, the entry tells the agent to follow the DSH guidance: it uses the plugin's `tmeet` instead of installing one, skips `agent_init.py`, and sends sign-in to the plugin page. References are ordinary files in the guide's directory.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [CLI account Service](../cli-account/README.md) — command execution, the CLI path context, and account operations shared by CLI app plugins.
- [Upstream skills Service](../upstream-skills/README.md) — download, verification, and publication of the guide.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the registry and the Plugins page section that drive the account operations.

-----

<a id="model-experience"></a>
## Model Experience

### Skill catalog entries

#### What the model sees

The skill catalog lists one `tencent-meeting` skill. Its Chinese description names the Tencent Meeting features it covers and tells the agent to load it, then read the `tmeet-skill` guide, whenever the user mentions Tencent Meeting, a meeting code, or meeting recordings or minutes.

#### Token effect

The entry stays in context while the plugin is loaded. Its name and description total about 130 characters.

#### KV Cache effect

The catalog is fixed for one plugin version. Loading or unloading the plugin changes the catalog, which is republished as a new message and leaves earlier context in place.

### Loaded skill body

#### What the model sees

A `skill` tool result for `tencent-meeting` contains about 1,200 characters: the DSH guidance, a one-sentence index of the `tmeet-skill` guide, and how to open it. The DSH guidance tells the agent to run the plugin's `tmeet` by the absolute path from the current runtime context, to skip the guide's installation check and its `agent_init.py` step, to ask the user to connect on the plugin page before running `tmeet auth login --no-browser` itself, and to request `sandbox_permissions` for that command from its first attempt; it takes precedence over the guide where they disagree. Its resource base is the downloaded directory, `skillsDir` or `$DSH_HOME/cache/tencent-meeting/skills-<digest>`, so the agent opens `skills/tmeet-skill/SKILL.md` with the file tools rather than the `skill` tool and resolves the guide's relative paths against the guide's own directory.

#### Token effect

Each load adds the entry body to the retained tool history. The guide, about 18,000 characters, and its reference files arrive as ordinary file-read output.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

### CLI path

#### What the model sees

While the row is loaded and the guide is in place, the [CLI account Service](../cli-account/README.md#model-experience) adds one required runtime-context entry with the path of the executable: `tmeet` in `binDir`, or by default the installed `@tencentcloud/tmeet` executable for this platform, such as `dist/tmeet-macOS-AppleSilicon`.

##### Runtime-context entry

```markdown
Tencent Meeting CLI: run `tmeet` by its absolute path "<executable>"; the bare name may resolve to another installation or to none.
```

##### Runtime-context entry on Windows

```markdown
Tencent Meeting CLI: run `tmeet` by its absolute path with the call operator, & '<executable>'; the bare name may resolve to another installation or to none.
```

#### Token effect

One line of about 115 characters plus the path in each runtime-context snapshot.

#### KV Cache effect

The system prompt does not change; finishing the guide's download, loading or unloading the row, or a changed path appends one runtime-context snapshot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS and Windows x64 are supported; Linux is unverified. `@tencentcloud/tmeet` ships no Windows arm64 executable.
- Installing a new `@tencentcloud/tmeet` version signs out tmeet on this computer, because its approved install script runs `tmeet auth logout`.
- Commands must run on this Host. When a composition runs them elsewhere, such as over SSH, the plugin still loads, and each command that runs `tmeet` fails because the path does not exist there.
- The plugin uses the CLI's default configuration. Signing in or out from DSH affects the user's own terminal, and there is no DSH-private account or account picker.
- The account state comes from the plain-text output of tmeet 1.0.18's `auth status`, and the sign-in link from its `authorize url:` line; a CLI version that changes that text fails the check or the sign-in with a retryable result. An account for which the server returns no user name reads as unconfirmed.
- The guide follows upstream tag `v1.0.18`; updating it means a new pin from `scripts/upstream-skills-digest.ts`, after which the entry's index and DSH guidance must be checked against the new guide.
- The first load after a new pin needs access to GitHub or a configured mirror; until a download succeeds, the agent has neither the `tencent-meeting` skill nor the `tmeet` path, and the page offers no sign-in. A computer that reaches neither needs `skillsDir`. A headless profile has no page check, so a download that failed at load is repeated only at the next load.
- The downloaded guide stays in `$DSH_HOME/cache/tencent-meeting/` after the plugin is removed or pins another commit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Specs, the `tencent-meeting-skills` session snapshot, and the Web e2e use stand-in executables through `binDir` and local directories through `skillsDir`, so none of them downloads the guide.

</details>
