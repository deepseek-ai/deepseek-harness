---
description: "Put the official tmeet on the private Shell PATH, load its skill, and run the account operations the Plugins page drives."
kind: "package-reference"
---

# @deepseek-ai/dsh-tencent-meeting-cli

English | [中文](README.zh.md)

## Summary

This package is the Host row of the [Tencent Meeting plugin](../tencent-meeting/README.md). It installs a pinned `@tencentcloud/tmeet`, links its platform executable as `tmeet` on the private Shell PATH, and registers one `tencent-meeting` skill whose guide is the official `tmeet-skill`. Its `tencentMeeting` Remote checks the CLI's sign-in, signs in through the CLI's authorization page, signs out, and cancels, for the [Tencent Meeting plugin page](../../client/ui-tencent-meeting/README.md). The CLI keeps the sign-in in its default configuration, which the user's own terminal shares. Only macOS is supported.

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

Install the [Tencent Meeting plugin bundle](../tencent-meeting/README.md), which inserts this package as the `tencent-meeting` row; that page covers the `@tencentcloud/tmeet` install script. When the package has no executable for the computer's platform, or the executable is missing, the plugin fails to load with an error that names the platform or path.

### What you get

After the plugin loads, one `tencent-meeting` skill joins the skill catalog. The agent loads it with the `skill` tool, opens the `tmeet-skill` guide and its references with the file tools, and runs `tmeet` commands through the ordinary Shell tools under the current sandbox and approval policy. When a command reports a missing or expired sign-in, the agent asks the user to connect Tencent Meeting on the plugin page; it runs `tmeet auth login --no-browser` only when the user asks to finish it in the conversation, and requests `sandbox_permissions` with a `justification` on the first attempt because the command writes outside the workspace.

Turning the row off in Plugin Manager withdraws the skill and the private PATH entry for later Shell calls. The CLI sign-in stays in place.

<a id="account-operations"></a>
### Account operations

The `tencentMeeting` Remote serves the Plugins page. It runs at most one operation at a time, owned by the Host, so leaving the page does not cancel it.

| Method | Effect |
|---|---|
| `follow(signal)` | Streams the account, the operation in progress, and the last result; each new follower starts a check when no operation runs |
| `check()` | Checks the account again; returns the operation id |
| `signIn()` | Runs `auth login --no-browser`, waits for the user to authorize on the Tencent Meeting page, then checks that the server accepts the new sign-in |
| `signOut()` | Runs `auth logout`, which also signs out the user's own terminal, then checks again |
| `cancel(id)` | Cancels a sign-in while it waits for authorization and waits for its command to exit; other steps and a finished id are ignored |

A check runs `auth status`, which in tmeet 1.0.18 prints plain text and exits with code 0 whether or not a user is signed in. The account reads `signed-out` for `Not logged in.`, for `Session has expired.`, or when `Logged in` comes with an expired refresh token; `connected`, with the user name, when `Logged in` comes with a `UserName:` line, which the CLI prints only after its user-info request to the server succeeds; and `unverified` for any other `Logged in`, for example when that request cannot reach the server. A nonzero exit or other output fails the check and keeps the previous account. The link that `auth login` prints on its `authorize url:` stdout line is offered only when it is an HTTPS address on `meeting.tencent.com`. Results report succeeded, cancelled, or failed. Failures include the command and the observed exit code in the Remote result and Host log; the CLI's output, which can carry the one-time authorization code, is omitted. The process running DSH needs access to the CLI configuration in `~/.tmeet`, the encrypted credentials in `~/Library/Application Support/tmeet`, and the macOS Keychain item that holds their key; `DSH_HOME` does not relocate them.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | a cache directory under the Harness home that links the installed `@tencentcloud/tmeet` executable for this platform | Absolute directory containing an executable `tmeet` |
| `commandTimeoutMs` | `30000` | Deadline for one account check or sign-out, including executable lookup |

Sign-in waits up to 10 minutes for the user, and each command keeps at most 1 MiB of stdout; the [CLI account library](../cli-account/README.md) fixes both limits. tmeet itself stops waiting for authorization after 5 minutes.

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-tencent-meeting-cli) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) is a Remote service registered as `ctx.tencentMeeting`. It requires a Host subprocess runtime, resolves the `tmeet` directory, registers it with [Shell environment](../../shell/shell-env/README.md) as the `tencent-meeting` PATH contribution, and mounts a [filesystem skill provider](../../skill/skill-filesystem/README.md) named `tencent-meeting` over this package's `skills/` directory, without the default roots or watching. `@tencentcloud/tmeet` ships one executable per platform under `dist/`, each named for its platform, and its `bin` is a Node launcher. [`src/directory.ts`](src/directory.ts) therefore picks the executable for `process.platform` and `process.arch` with the same names the launcher uses, and links it as `tmeet` in `$DSH_HOME/cache/tencent-meeting/<hash>/`, where the hash is the first 16 hex digits of the SHA-256 of the executable's path. It replaces that link atomically on each load, so installations at different paths never share a link. The [CLI account library](../cli-account/README.md) runs each command on the private PATH, so the backend and the Shell use the same executable, and runs one operation at a time. [`src/account.ts`](src/account.ts) extends that runtime with the tmeet commands, reads the authorization link from the output lines of `auth login`, and parses the `auth status` text. Disposal cancels the active operation, aborts running commands, and settles after their processes exit.

[`skills/tencent-meeting/SKILL.md`](skills/tencent-meeting/SKILL.md) is the only skill: the DSH guidance, an index of the guide, and how to open it. [`skills/tencent-meeting/guides/tmeet-skill/`](skills/tencent-meeting/guides/tmeet-skill) is an unchanged copy of `SKILL.md` and `references/` from `skills/tmeet-skill/` in `TencentCloud/tencentmeeting-cli` at tag `v1.0.18` (commit `e631b35`), because upstream publishes the skill only in that repository and not in the npm package. Its `scripts/agent_init.py`, which records the calling agent and model in the CLI configuration for upstream telemetry, is not copied. The filesystem provider discovers only `<root>/<name>/SKILL.md`, so the guide is not a separate skill. Where the DSH guidance and the guide disagree, the entry tells the agent to follow the DSH guidance: it uses the plugin's `tmeet` instead of installing one, skips `agent_init.py`, and sends sign-in to the plugin page. References are ordinary files in the guide's directory.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [CLI account library](../cli-account/README.md) — command execution and account operations shared by CLI app plugins.
- [Shell environment](../../shell/shell-env/README.md) — private PATH contributions shared by backend subprocesses and Shell tools.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [Tencent Meeting plugin](../tencent-meeting/README.md) — the bundle that inserts this row and the page row.
- [Tencent Meeting plugin page](../../client/ui-tencent-meeting/README.md) — the Plugins page that drives the account operations.

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

A `skill` tool result for `tencent-meeting` contains about 1,200 characters: the DSH guidance, a one-sentence index of the `tmeet-skill` guide, and how to open it. The DSH guidance tells the agent to run the plugin's `tmeet` by name, to skip the guide's installation check and its `agent_init.py` step, to ask the user to connect on the plugin page before running `tmeet auth login --no-browser` itself, and to request `sandbox_permissions` for that command from its first attempt; it takes precedence over the guide where they disagree. Its resource base is `skills/tencent-meeting`, so the agent opens `guides/tmeet-skill/SKILL.md` with the file tools rather than the `skill` tool and resolves the guide's relative paths against the guide's own directory.

#### Token effect

Each load adds the entry body to the retained tool history. The guide, about 18,000 characters, and its reference files arrive as ordinary file-read output.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

### Plugin CLIs entry

#### What the model sees

The row declares `tmeet` with its private PATH entry, so the [Shell environment](../../shell/shell-env/README.md#model-experience) Plugin CLIs section of the system prompt lists `` `tmeet` (tencent-meeting) `` while the row is loaded and the shell runs on this Host.

#### Token effect

The entry adds a few tokens to that section; the section's own text belongs to Shell environment.

#### KV Cache effect

Loading or unloading the row changes the section text, and provider cache reuse may end at the first changed token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS is supported. Linux is unverified, and Windows has no linked executable.
- The plugin requires a subprocess runtime on this Host and fails to load when the composition's subprocess runtime runs elsewhere, such as over SSH.
- The plugin uses the CLI's default configuration. Signing in or out from DSH affects the user's own terminal, and there is no DSH-private account or account picker.
- The account state comes from the plain-text output of tmeet 1.0.18's `auth status`, and the sign-in link from its `authorize url:` line; a CLI version that changes that text fails the check or the sign-in with a retryable result. An account for which the server returns no user name reads as unconfirmed.
- Removing the plugin leaves its link directory in the Harness cache.
- The guide follows upstream tag `v1.0.18`; updating it is a manual copy, after which the entry's index and DSH guidance must be checked against the new guide.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The guide keeps upstream whitespace, including one whitespace-only line in `SKILL.md` and four files without a final newline, and no whitespace exemption covers it: a commit that adds upstream lines with trailing whitespace fails the pre-commit `git diff --cached --check`. Specs and the `tencent-meeting-skills` session snapshot use stand-in executables through `binDir`.

</details>
